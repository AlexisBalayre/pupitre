import type { Database } from 'better-sqlite3';
import { auditProject } from './audit.service.js';
import { rethrowIfKilled } from './git-diff.client.js';
import {
  assertAuditable,
  checkLanding,
  fetchTarget,
  LAND_UNTOUCHED,
  landUnderLock,
} from './land.service.js';
import {
  assertMergeLockHeld,
  isAncestor,
  MERGE_LOCK_WAIT_MS,
  resolveCommit,
  withMergeLock,
} from './merge-gate.service.js';
import { NO_PROGRESS, type StageProgress } from './progress.utils.js';
import { GateInterruptedError } from './sandbox.utils.js';
import type { Landable, LandBatchOutcome, LandRequest } from './types/land.types.js';

/**
 * `pup land <session> <session> ...` (decision 195): several sessions whose
 * PRs merged on GitHub, landed under one hold of the merge lock and audited
 * once, on the final target. Each session gets `landSession`'s checks,
 * fast-forward, teardown, `landed` event and steer, in the order GitHub merged
 * them. A session its own checks refuse, before the lock or under it, is
 * returned with the refusal and the rest go on; only an interrupt, a kill or
 * a lost merge lock stops them. An interrupt under the lock, whether or not it
 * killed a child, stops the batch before the next land and before the audit
 * with `GateInterruptedError`. The audit runs under the lock once at least
 * one landed, and a failed one is returned rather than thrown, since every
 * land before it stands. A moved head is one session's question, so this
 * takes neither `acceptHead` nor `remeasure`. A lock lost under the lands
 * stops the batch before the next land and before the audit, and the release
 * then throws `MergeLockLostError` carrying the batch outcome (decision 88).
 */
export async function landSessions(
  db: Database,
  req: Omit<LandRequest, 'sessionId' | 'acceptHead' | 'remeasure' | 'approvedBy'> & {
    sessionIds: string[];
  },
  progress: StageProgress = NO_PROGRESS,
): Promise<LandBatchOutcome> {
  if (req.audit !== false) assertAuditable(req);
  // The flags that vouch for one session's head never ride along, whatever
  // the caller's object holds past its type.
  const one = (sessionId: string): LandRequest => ({
    ...req,
    sessionId,
    acceptHead: undefined,
    remeasure: false,
    approvedBy: undefined,
  });
  const refused: LandBatchOutcome['refused'] = [];
  const landable: Landable[] = [];
  for (const sessionId of new Set(req.sessionIds)) {
    progress.stage('read PR');
    try {
      landable.push(checkLanding(db, one(sessionId)));
    } catch (error) {
      refused.push(refusalOf(sessionId, error));
    }
  }
  if (landable.length === 0) return { landed: [], refused };
  return withMergeLock(
    req.repoPath,
    async (): Promise<LandBatchOutcome> => {
      // `withMergeLock` discards a signal that kills no child, during pup's
      // own work such as a steer's waits; one land then just finishes, but a
      // batch would go on to land the rest, so it records the signal itself.
      let interrupted: Interrupt | undefined;
      const onSignal = (signal: Interrupt): void => {
        interrupted ??= signal;
      };
      for (const signal of INTERRUPTS) process.on(signal, onSignal);
      const stopIfInterrupted = async (): Promise<void> => {
        await signalsDelivered();
        if (interrupted) throw new GateInterruptedError(interrupted);
      };
      try {
        const landed: LandBatchOutcome['landed'] = [];
        const order = inMergeOrder(req.repoPath, landable);
        for (const [at, next] of order.entries()) {
          await stopIfInterrupted();
          // A lost lock is the whole batch's: another merge or land may be
          // running, so nothing more moves and the release throws (decision 88).
          if (!mergeLockHeld(req.repoPath)) {
            const untried = order.slice(at).map(({ session }) => ({
              sessionId: session.id,
              reason: `Not tried: the merge lock was lost under the batch. ${BATCH_UNTOUCHED}`,
            }));
            return { landed, refused: [...refused, ...untried] };
          }
          try {
            const outcome = await landUnderLock(db, one(next.session.id), next, progress);
            landed.push({ sessionId: next.session.id, outcome });
          } catch (error) {
            refused.push(refusalOf(next.session.id, error));
          }
        }
        if (landed.length === 0 || req.audit === false) return { landed, refused };
        await stopIfInterrupted();
        // The audit keeps the baseline it writes, so never without the lock.
        if (!mergeLockHeld(req.repoPath)) return { landed, refused };
        // Under the lock, for `landSession`'s reason (decision 88).
        progress.stage('audit');
        try {
          const audit = await auditProject(db, req.repoPath, req.adapters, req.gateEnv, 'keep');
          return { landed, refused, audit };
        } catch (error) {
          if (error instanceof GateInterruptedError) throw error;
          rethrowIfKilled(error);
          return { landed, refused, auditFailure: messageOf(error) };
        }
      } finally {
        for (const signal of INTERRUPTS) process.off(signal, onSignal);
      }
    },
    req.wait ? MERGE_LOCK_WAIT_MS : 0,
    progress,
  );
}

/**
 * What a refused session in a batch is left with: an earlier land moves the
 * local target to origin's tip, which may hold this session's merge commit.
 */
const BATCH_UNTOUCHED =
  'No `landed` event was recorded for it, and main may already hold its merge commit.';

/**
 * One session's refusal in a batch; an interrupt or a kill is the whole run's.
 * "Nothing was landed" holds for one land, not in a batch, so it is reworded.
 */
function refusalOf(sessionId: string, error: unknown): LandBatchOutcome['refused'][number] {
  if (error instanceof GateInterruptedError) throw error;
  rethrowIfKilled(error);
  return { sessionId, reason: messageOf(error).replaceAll(LAND_UNTOUCHED, BATCH_UNTOUCHED) };
}

type Interrupt = GateInterruptedError['signal'];

/** The signals `withMergeLock` keeps node alive through while it holds the lock. */
const INTERRUPTS: readonly Interrupt[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Lets node run the listener of a signal that arrived during the synchronous
 * lands. Node calls it from the event loop's poll phase. An immediate set
 * during a poll runs before the next poll, so a second immediate, set from
 * the first, is what makes sure one poll has passed.
 */
async function signalsDelivered(): Promise<void> {
  for (let turn = 0; turn < 2; turn++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Whether this run still holds `repoPath`'s merge lock as it took it. */
function mergeLockHeld(repoPath: string): boolean {
  try {
    assertMergeLockHeld(repoPath, 'the next step of the batch');
    return true;
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The landable sessions in the order GitHub merged them: after each, the ones
 * whose merge commit descends from its. Origin's target is fetched once per
 * origin and target first, as GitHub made those commits; a fetch that fails
 * keeps the order given, and each land's own fetch then refuses. Only the
 * order rests on this read: each land still checks its own merge commit.
 */
function inMergeOrder(repoPath: string, landable: Landable[]): Landable[] {
  const fetched = new Set<string>();
  for (const { originUrl, target } of landable) {
    const key = `${originUrl}\n${target}`;
    if (fetched.has(key)) continue;
    fetched.add(key);
    try {
      fetchTarget(
        repoPath,
        originUrl,
        target,
        resolveCommit(repoPath, `refs/heads/${target}`),
        undefined,
      );
    } catch (error) {
      if (error instanceof GateInterruptedError) throw error;
      rethrowIfKilled(error);
    }
  }
  const earlier = (one: Landable) =>
    landable.filter(
      (other) => other !== one && isAncestor(repoPath, other.mergeCommit, one.mergeCommit),
    ).length;
  return landable
    .map((one) => ({ one, after: earlier(one) }))
    .sort((a, b) => a.after - b.after)
    .map(({ one }) => one);
}
