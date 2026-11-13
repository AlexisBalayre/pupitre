import type { Database } from 'better-sqlite3';

import { detectAdapters } from '../adapters/adapter.registry.js';
import { sanitizeReason } from '../adapters/capability.utils.js';
import { resolveWindowEnv } from '../claude/session-runtime.service.js';
import { tellConductor } from './conductor.service.js';
import { CONDUCTOR_TARGET, openThreadCount } from './dashboard.service.js';
import { DEFAULT_BASE_PROFILE } from './default-profile.constants.js';
import { startFixRound } from './fix-round.service.js';
import { landSession } from './land.service.js';
import { closeLedgerEntry } from './ledger.repository.js';
import { MergeLockLostError } from './merge-gate.errors.js';
import { runMergeGate } from './merge-gate.service.js';
import { sandboxLabel } from './sandbox.utils.js';
import {
  answerConductorQuestion,
  answerSessionQuestion,
  killedFixRoundMessage,
  killSession,
  launchTask,
  steerSession,
} from './session-lifecycle.service.js';
import type { LandOutcome } from './types/land.types.js';
import type { MergeOutcome } from './types/merge-gate.types.js';
import { escapeHtml } from './web-dashboard-sheet.utils.js';

/** What the page can ask the server to do, each the core call its CLI command makes (decision 91). */
export const ACTIONS = [
  'answer',
  'tell',
  'steer',
  'launch',
  'kill',
  'merge',
  'fix',
  'land',
  'debt-close',
] as const;
export type ActionName = (typeof ACTIONS)[number];

/** The ones that cannot be taken back: the page asks before each runs (decision 91). */
export const CONFIRMED_ACTIONS = [
  'kill',
  'merge',
  'land',
  'debt-close',
] as const satisfies readonly ActionName[];
export type ConfirmedAction = (typeof CONFIRMED_ACTIONS)[number];

/** Whether the page must ask before `action` runs. */
export function isConfirmed(action: ActionName): action is ConfirmedAction {
  return (CONFIRMED_ACTIONS as readonly ActionName[]).includes(action);
}

export type ActionFields = Record<string, string>;

/** A field the action cannot run without, or a refusal naming it. */
function field(fields: ActionFields, name: string): string {
  const value = fields[name]?.trim() ?? '';
  if (value === '') throw new Error(`The action needs a ${name}; nothing was done.`);
  return value;
}

/** The ledger acceptance a merge carries, or undefined for a plain `--pr` gate; refused as `pup merge` refuses. */
function acceptDebtOf(fields: ActionFields) {
  const reason = fields.reason?.trim() ?? '';
  const reviewBy = fields.reviewBy?.trim() ?? '';
  if (Boolean(reason) !== Boolean(reviewBy)) {
    throw new Error('A debt reason and a review-by go together; nothing was gated.');
  }
  if (!reason) return undefined;
  // Scrubbed before it is stored, and refused when nothing is left, as
  // `--approved-by` is (decision 75). The form names `human` until the
  // operator names someone else, so an acceptor is never assumed.
  const approver = sanitizeReason(fields.approver ?? '');
  if (approver === '') {
    throw new Error(
      'Accepting debt needs an approver, such as human or tg:<user>; nothing was gated.',
    );
  }
  return { reason, reviewBy, acceptedBy: approver };
}

/**
 * The question the page asks before an irreversible action runs, built from
 * the request's own fields so the operator confirms what will be sent.
 */
export function confirmationText(action: ConfirmedAction, fields: ActionFields): string {
  const session = sanitizeReason(fields.session ?? '');
  switch (action) {
    case 'kill':
      return `Kill session ${session}? Its window closes and its task goes back to the backlog.`;
    case 'merge': {
      const debt = acceptDebtOf(fields);
      return debt
        ? `Gate session ${session} and open its pull request, accepting what the gate flags as debt ` +
            `("${sanitizeReason(debt.reason)}", review by ${sanitizeReason(debt.reviewBy)}, accepted by ${debt.acceptedBy})?`
        : `Gate session ${session} and open its pull request?`;
    }
    case 'land':
      return `Land session ${session}? Its merged PR's target fast-forwards, the session is cleaned up and the audit runs.`;
    case 'debt-close':
      return `Close ledger entry #${sanitizeReason(fields.id ?? '')}? Only once a merge has removed the shortcut.`;
  }
}

/**
 * Run one action through the core function its CLI command calls, and return
 * the lines that say what it did. A refusal is the error core threw, its text
 * unchanged, for the server to show; the dashboard is the operator's alone, so
 * every action is the operator's (decision 91). The merge gate, the land and
 * the fix round take no lock wait: a page refuses at once where the CLI waits.
 */
export async function runAction(
  db: Database,
  repoPath: string,
  action: ActionName,
  fields: ActionFields,
): Promise<string[]> {
  switch (action) {
    case 'answer': {
      const target = field(fields, 'target');
      const reply = field(fields, 'reply');
      if (target === CONDUCTOR_TARGET) {
        return [
          `Answered the conductor: ${sanitizeReason(answerConductorQuestion(db, repoPath, reply).text)}`,
        ];
      }
      return [
        `Answered session ${sanitizeReason(target)}: ${sanitizeReason(answerSessionQuestion(db, target, reply).text)}`,
      ];
    }
    case 'tell': {
      if (!tellConductor(repoPath, field(fields, 'message'))) {
        throw new Error(
          "The message did not land: the conductor's input box never showed it whole, still holds " +
            'text after a second Enter, or left the screen. Look with `pup attach`.',
        );
      }
      return ['Told the conductor; the message landed.'];
    }
    case 'steer': {
      const session = field(fields, 'session');
      steerSession(db, session, field(fields, 'message'), { kind: 'manual', by: 'operator' });
      return [`Steered session ${sanitizeReason(session)}.`];
    }
    case 'launch': {
      const sessionId = launchTask(db, {
        repoPath,
        base: DEFAULT_BASE_PROFILE,
        taskId: field(fields, 'task'),
        windowEnv: resolveWindowEnv(repoPath),
        overrideVia: 'operator',
      });
      return [
        `Launched session ${sanitizeReason(sessionId)}.`,
        `Attach with: pup attach ${sanitizeReason(sessionId)}`,
      ];
    }
    case 'kill': {
      const session = field(fields, 'session');
      return [
        killSession(db, session) === 'merged'
          ? killedFixRoundMessage(session)
          : `Killed session ${sanitizeReason(session)}.`,
      ];
    }
    case 'merge':
      return mergeAction(db, repoPath, field(fields, 'session'), acceptDebtOf(fields));
    case 'fix': {
      const session = field(fields, 'session');
      const outcome = await startFixRound(db, {
        repoPath,
        base: DEFAULT_BASE_PROFILE,
        windowEnv: resolveWindowEnv(repoPath),
        sessionId: session,
        overrideVia: 'operator',
      });
      return [
        `Fix round started for ${sanitizeReason(session)}: the ${openThreadCount(outcome.threads)} the CI review left on ` +
          `${outcome.prUrl} at ${outcome.head} went to a fresh window.`,
      ];
    }
    case 'land':
      return landAction(db, repoPath, field(fields, 'session'));
    case 'debt-close': {
      const id = field(fields, 'id');
      if (!closeLedgerEntry(db, Number(id))) {
        throw new Error(`No open ledger entry #${sanitizeReason(id)}.`);
      }
      return [`Closed ledger entry #${sanitizeReason(id)}.`];
    }
  }
}

/**
 * `pup merge <session> --pr [--accept-debt]`: always with `--pr`, so the page
 * never moves the target branch itself; the PR is merged on GitHub, which the
 * page only links to (decision 91). A lock lost under the gate reports what
 * the gate did, then why it cannot be trusted alone, as the CLI does.
 */
async function mergeAction(
  db: Database,
  repoPath: string,
  session: string,
  acceptDebt: ReturnType<typeof acceptDebtOf>,
): Promise<string[]> {
  const adapters = detectAdapters(repoPath);
  if (adapters.length === 0) {
    throw new Error(
      'No adapter detected for this repo (supported stacks: TypeScript, Python, or a .pupitre/adapter.yml).',
    );
  }
  let outcome: MergeOutcome;
  let lost = '';
  try {
    outcome = await runMergeGate(db, {
      repoPath,
      sessionId: session,
      adapters,
      acceptDebt,
      openPr: true,
    });
  } catch (error) {
    if (!(error instanceof MergeLockLostError)) throw error;
    outcome = error.result as MergeOutcome;
    lost = error.message;
  }
  const id = sanitizeReason(session);
  const stages = outcome.report.stages.map(
    (stage) =>
      `${sanitizeReason(stage.stage)}: ${stage.status}${stage.detail ? ` — ${sanitizeReason(stage.detail)}` : ''}`,
  );
  const failed = outcome.report.stages.find((stage) => stage.status === 'fail');
  const flagged = outcome.report.stages
    .filter((stage) => stage.status === 'flagged')
    .map((stage) => sanitizeReason(stage.stage))
    .join(', ');
  const verdict =
    outcome.status === 'merged'
      ? `Gate passed; ${outcome.prUrl ?? 'the pull request'} carries this gate report — merge it on GitHub, then land ${id}.`
      : outcome.status === 'refused'
        ? failed
          ? `Merge refused: ${sanitizeReason(failed.stage)} failed, which accepting debt does not cover. Steer the session to fix it.`
          : `Merge refused: ${flagged} flagged. Accept it as debt with a reason and a review-by, or steer the session to address the flags.`
        : outcome.status === 'rejected'
          ? `Gate failed; report re-injected into the session (rejection ${outcome.rejectCount}/2).`
          : `Gate failed; session parked as blocked — needs a human, then \`pup unblock ${id}\`.`;
  const candidates = (outcome.debtCandidates ?? []).map(
    (c) =>
      `This merge touched files of open debt #${c.id} (${sanitizeReason(c.description)}) — close it once the shortcut is gone.`,
  );
  const record =
    outcome.decisionRecordId === undefined
      ? []
      : [`Drafted decision record #${outcome.decisionRecordId}; the Decisions sheet lists it.`];
  const lines = [verdict, ...stages, ...candidates, ...record];
  // Shown, and then refused: what the gate did stands, but unprotected (decision 88).
  if (lost) throw new Error([...lines, lost].join('\n'));
  if (outcome.status !== 'merged') throw new Error(lines.join('\n'));
  return lines;
}

/**
 * `pup land <session>`: asked of the sandbox first, as the CLI asks before it
 * lands. What the land did is said whole, each peer it could not steer named,
 * and then refused where `pup land` fails: a lock lost under it (decision 88),
 * or an audit that kept the baseline.
 */
async function landAction(db: Database, repoPath: string, session: string): Promise<string[]> {
  sandboxLabel();
  let outcome: LandOutcome;
  let lost = '';
  try {
    outcome = await landSession(db, {
      repoPath,
      sessionId: session,
      adapters: detectAdapters(repoPath),
    });
  } catch (error) {
    if (!(error instanceof MergeLockLostError)) throw error;
    outcome = error.result as LandOutcome;
    lost = error.message;
  }
  const target = sanitizeReason(outcome.target);
  const audit = outcome.audit;
  const kept =
    audit === undefined
      ? []
      : audit.unmeasured.length > 0
        ? [
            ...audit.unmeasured.map(sanitizeReason),
            `Baseline kept: ${audit.unmeasured.length === 1 ? 'a debt metric was' : 'debt metrics were'} not measured, ` +
              `so the baseline from ${sanitizeReason(audit.previous?.capturedAt ?? '')} still stands. Fix the measurement ` +
              'and re-run `pup audit`.',
          ]
        : audit.heldOnRegression
          ? [
              'Baseline kept: the measurement regressed, and a land does not move the bar over a ' +
                'regression; run `pup audit` to accept it or fix it first.',
            ]
          : [];
  const lines = [
    `Landed ${sanitizeReason(session)}: ${outcome.prUrl} merged as ${outcome.mergeCommit}; ` +
      (outcome.fastForwarded
        ? `${target} fast-forwarded to ${outcome.targetSha}.`
        : `${target} already held it at ${outcome.targetSha}.`),
    ...(outcome.keptWorktree === undefined
      ? []
      : [`Kept the worktree at ${sanitizeReason(outcome.keptWorktree)}: git could not remove it.`]),
    ...(outcome.keptBranch === undefined
      ? []
      : [`Kept ${sanitizeReason(outcome.keptBranch)}: it holds commits ${target} does not.`]),
    ...(outcome.unsteered ?? []).map(
      ({ sessionId, reason }) =>
        `Could not tell ${sanitizeReason(sessionId)} that ${target} moved: ${sanitizeReason(reason)}. ` +
        `Steer it to take ${target} in.`,
    ),
    ...(audit === undefined
      ? ['Audit skipped: run `pup audit` once after the last land.']
      : kept.length > 0
        ? kept
        : ['The audit ran; the Health sheet shows its figures.']),
  ];
  if (lost) throw new Error([...lines, lost].join('\n'));
  if (kept.length > 0) throw new Error(lines.join('\n'));
  return lines;
}

/**
 * One action's form. The page's script posts it with the page's secret and
 * the nonce its stream handed it; `form-action 'none'` keeps the browser from submitting it any
 * other way. Every value is escaped: ids and option text are store text.
 */
export function actionForm(
  action: ActionName,
  hidden: ActionFields,
  body: string,
  className = 'act',
): string {
  const inputs = Object.entries(hidden)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join('');
  return `<form class="${className}" data-action="${action}">${inputs}${body}</form>`;
}

/** A form that is one button, for an action whose fields are all known. */
export function actionButton(action: ActionName, hidden: ActionFields, label: string): string {
  return actionForm(action, hidden, `<button type="submit">${escapeHtml(label)}</button>`);
}

/**
 * An open question's answers (decision 93): one button per option, sending
 * its number as `pup answer <target> <n>` does, the recommended one marked,
 * then an answer in words. `target` is the session, or `conductor`.
 */
export function answerForms(
  target: string,
  question: { options: string[]; recommended?: number },
): string {
  const options = question.options.map(
    (option, i) =>
      `<button type="submit" name="reply" value="${i + 1}"${i + 1 === question.recommended ? ' class="recommended"' : ''}>` +
      `${escapeHtml(`${i + 1}. ${option}${i + 1 === question.recommended ? ' (recommended)' : ''}`)}</button>`,
  );
  return (
    (options.length === 0
      ? ''
      : actionForm('answer', { target }, options.join(''), 'act options')) +
    textAction('answer', { target }, 'reply', 'answer in words', 'Answer')
  );
}

/** A form with one text field and its button: an answer in words, a steer, a tell. */
export function textAction(
  action: ActionName,
  hidden: ActionFields,
  name: string,
  placeholder: string,
  label: string,
): string {
  return actionForm(
    action,
    hidden,
    `<input type="text" name="${escapeHtml(name)}" placeholder="${escapeHtml(placeholder)}" required>` +
      `<button type="submit">${escapeHtml(label)}</button>`,
  );
}
