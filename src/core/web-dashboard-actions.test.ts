import type { Database } from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Every core call the actions make is faked: what is under test is that each
// action reaches the one its CLI command reaches, with the same arguments,
// and hands back core's refusal as it was thrown (decision 91).
vi.mock('../adapters/adapter.registry.js', () => ({ detectAdapters: vi.fn(() => [ADAPTER]) }));
vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  resolveWindowEnv: vi.fn(() => WINDOW_ENV),
}));
vi.mock('./conductor.service.js', () => ({ tellConductor: vi.fn() }));
vi.mock('./fix-round.service.js', () => ({ startFixRound: vi.fn() }));
vi.mock('./land.service.js', () => ({ landSession: vi.fn() }));
vi.mock('./ledger.repository.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ledger.repository.js')>()),
  closeLedgerEntry: vi.fn(),
}));
vi.mock('./merge-gate.service.js', () => ({ runMergeGate: vi.fn() }));
vi.mock('./sandbox.utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sandbox.utils.js')>()),
  sandboxLabel: vi.fn(() => 'seatbelt'),
}));
vi.mock('./session-lifecycle.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-lifecycle.service.js')>()),
  answerConductorQuestion: vi.fn(),
  answerSessionQuestion: vi.fn(),
  killSession: vi.fn(),
  launchTask: vi.fn(),
  steerSession: vi.fn(),
}));

import { tellConductor } from './conductor.service.js';
import { DEFAULT_BASE_PROFILE } from './default-profile.constants.js';
import { startFixRound } from './fix-round.service.js';
import { landSession } from './land.service.js';
import { closeLedgerEntry } from './ledger.repository.js';
import { MergeLockLostError } from './merge-gate.errors.js';
import { runMergeGate } from './merge-gate.service.js';
import { sandboxLabel, UndeclaredSandboxError } from './sandbox.utils.js';
import {
  answerConductorQuestion,
  answerSessionQuestion,
  killSession,
  launchTask,
  steerSession,
} from './session-lifecycle.service.js';
import type { MergeOutcome } from './types/merge-gate.types.js';
import {
  type ActionFields,
  type ActionName,
  answerForms,
  CONFIRMED_ACTIONS,
  confirmationText,
  runAction,
} from './web-dashboard-actions.service.js';

const ADAPTER = { id: 'typescript' };
const WINDOW_ENV = { vars: {}, configDir: '/home/op/.claude' };
const DB = { name: 'store' } as unknown as Database;
const REPO = '/repo';
const PR = 'https://github.com/o/r/pull/7';

function gate(status: MergeOutcome['status'], stages: MergeOutcome['report']['stages']) {
  return {
    status,
    rejectCount: 1,
    prUrl: status === 'merged' ? PR : undefined,
    report: { sessionId: 's-1', passed: status === 'merged', sandbox: 'seatbelt', stages },
  } as MergeOutcome;
}

/** Each action: its fields, the core call it must make and how, and how that call refuses. */
const CASES: {
  action: ActionName;
  fields: ActionFields;
  /** Makes the core call answer, and says which mock it is. */
  arrange: () => ReturnType<typeof vi.fn>;
  expectCall: unknown[];
  lines: string[];
}[] = [
  {
    action: 'answer',
    fields: { target: 's-1', reply: '2' },
    arrange: () => vi.mocked(answerSessionQuestion).mockReturnValue({ text: 'rebase' } as never),
    expectCall: [DB, 's-1', '2'],
    lines: ['Answered session s-1: rebase'],
  },
  {
    action: 'answer',
    fields: { target: 'conductor', reply: 'ship it' },
    arrange: () => vi.mocked(answerConductorQuestion).mockReturnValue({ text: 'ship it' } as never),
    expectCall: [DB, REPO, 'ship it'],
    lines: ['Answered the conductor: ship it'],
  },
  {
    action: 'tell',
    fields: { message: 'plan t-9 next' },
    arrange: () => vi.mocked(tellConductor).mockReturnValue(true),
    expectCall: [REPO, 'plan t-9 next'],
    lines: ['Told the conductor; the message landed.'],
  },
  {
    action: 'steer',
    fields: { session: 's-1', message: 'run the tests' },
    arrange: () => vi.mocked(steerSession).mockReturnValue(undefined as never),
    expectCall: [DB, 's-1', 'run the tests', { kind: 'manual', by: 'operator' }],
    lines: ['Steered session s-1.'],
  },
  {
    action: 'launch',
    fields: { task: 't-9' },
    arrange: () => vi.mocked(launchTask).mockReturnValue('s-9'),
    expectCall: [
      DB,
      {
        repoPath: REPO,
        base: DEFAULT_BASE_PROFILE,
        taskId: 't-9',
        windowEnv: WINDOW_ENV,
        overrideVia: 'operator',
      },
    ],
    lines: ['Launched session s-9.', 'Attach with: pup attach s-9'],
  },
  {
    action: 'kill',
    fields: { session: 's-1' },
    arrange: () => vi.mocked(killSession).mockReturnValue('killed'),
    expectCall: [DB, 's-1'],
    lines: ['Killed session s-1.'],
  },
  {
    action: 'merge',
    fields: { session: 's-1', reason: 'one feature', reviewBy: '2027-01-01', approver: 'human' },
    arrange: () =>
      vi
        .mocked(runMergeGate)
        .mockResolvedValue(gate('merged', [{ stage: 'build', status: 'pass' }])),
    expectCall: [
      DB,
      {
        repoPath: REPO,
        sessionId: 's-1',
        adapters: [ADAPTER],
        acceptDebt: { reason: 'one feature', reviewBy: '2027-01-01', acceptedBy: 'human' },
        openPr: true,
      },
    ],
    lines: [
      `Gate passed; ${PR} carries this gate report — merge it on GitHub, then land s-1.`,
      'build: pass',
    ],
  },
  {
    action: 'fix',
    fields: { session: 's-1' },
    arrange: () =>
      vi
        .mocked(startFixRound)
        .mockResolvedValue({ prUrl: PR, head: 'abc1234', threads: 2 } as never),
    expectCall: [
      DB,
      {
        repoPath: REPO,
        base: DEFAULT_BASE_PROFILE,
        windowEnv: WINDOW_ENV,
        sessionId: 's-1',
        overrideVia: 'operator',
      },
    ],
    lines: [
      `Fix round started for s-1: the 2 open threads the CI review left on ${PR} at abc1234 went to a fresh window.`,
    ],
  },
  {
    action: 'land',
    fields: { session: 's-1' },
    arrange: () =>
      vi.mocked(landSession).mockResolvedValue({
        prUrl: PR,
        mergeCommit: 'm1',
        target: 'main',
        targetSha: 'm1',
        fastForwarded: true,
        removedWorktree: true,
      } as never),
    expectCall: [DB, { repoPath: REPO, sessionId: 's-1', adapters: [ADAPTER] }],
    lines: [`Landed s-1: ${PR} merged as m1; main fast-forwarded to m1.`, 'Audit skipped.'],
  },
  {
    action: 'debt-close',
    fields: { id: '4' },
    arrange: () => vi.mocked(closeLedgerEntry).mockReturnValue(true),
    expectCall: [DB, 4],
    lines: ['Closed ledger entry #4.'],
  },
];

describe('runAction', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each(CASES)('$action calls the core function its CLI command calls', async (c) => {
    const call = c.arrange();

    await expect(runAction(DB, REPO, c.action, c.fields)).resolves.toEqual(c.lines);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(...c.expectCall);
  });

  it.each(CASES)("$action shows core's refusal as core worded it", async (c) => {
    const call = c.arrange();
    call.mockImplementation(() => {
      throw new Error(`Core refused ${c.action}.`);
    });

    await expect(runAction(DB, REPO, c.action, c.fields)).rejects.toThrow(
      `Core refused ${c.action}.`,
    );
  });

  it('refuses a debt close core finds nothing open for, and a tell that never landed', async () => {
    vi.mocked(closeLedgerEntry).mockReturnValue(false);
    vi.mocked(tellConductor).mockReturnValue(false);

    await expect(runAction(DB, REPO, 'debt-close', { id: '99' })).rejects.toThrow(
      'No open ledger entry #99.',
    );
    await expect(runAction(DB, REPO, 'tell', { message: 'hi' })).rejects.toThrow(
      'The message did not land',
    );
  });

  it('refuses before core is reached when a field the action needs is missing', async () => {
    await expect(runAction(DB, REPO, 'kill', { session: ' ' })).rejects.toThrow(
      'The action needs a session; nothing was done.',
    );
    expect(killSession).not.toHaveBeenCalled();
  });

  it('refuses a debt reason without its review-by, as `pup merge` does, before the gate runs', async () => {
    await expect(
      runAction(DB, REPO, 'merge', { session: 's-1', reason: 'one feature' }),
    ).rejects.toThrow('A debt reason and a review-by go together; nothing was gated.');
    expect(runMergeGate).not.toHaveBeenCalled();
  });

  it.each([
    ['no approver', undefined],
    ['a blank approver', '  '],
    ['an approver nothing is left of once scrubbed', '\u001b\u0007'],
  ])(
    'refuses accepting debt with %s, as --approved-by refuses it, and gates nothing',
    async (_case, approver) => {
      const fields = { session: 's-1', reason: 'r', reviewBy: 'q1' };

      await expect(
        runAction(DB, REPO, 'merge', approver === undefined ? fields : { ...fields, approver }),
      ).rejects.toThrow(
        'Accepting debt needs an approver, such as human or tg:<user>; nothing was gated.',
      );
      expect(runMergeGate).not.toHaveBeenCalled();
    },
  );

  it('gates without debt and with a named approver, scrubbed, always with --pr', async () => {
    vi.mocked(runMergeGate).mockResolvedValue(gate('merged', []));

    await runAction(DB, REPO, 'merge', { session: 's-1' });
    await runAction(DB, REPO, 'merge', {
      session: 's-1',
      reason: 'r',
      reviewBy: 'q1',
      approver: 'tg:\u001b[31mana',
    });

    expect(
      vi.mocked(runMergeGate).mock.calls.map(([, req]) => [req.acceptDebt, req.openPr]),
    ).toEqual([
      [undefined, true],
      [{ reason: 'r', reviewBy: 'q1', acceptedBy: 'tg: [31mana' }, true],
    ]);
  });

  it('shows a flagged gate as a refusal naming the flags', async () => {
    vi.mocked(runMergeGate).mockResolvedValue(
      gate('refused', [{ stage: 'diff size', status: 'flagged', detail: '812 lines' }]),
    );

    await expect(runAction(DB, REPO, 'merge', { session: 's-1' })).rejects.toThrow(
      'Merge refused: diff size flagged. Accept it as debt with a reason and a review-by, or steer the session to address the flags.\ndiff size: flagged — 812 lines',
    );
  });

  it('reports what the gate did and then refuses when the lock was lost under it', async () => {
    vi.mocked(runMergeGate).mockRejectedValue(new MergeLockLostError('/lock', gate('merged', [])));

    await expect(runAction(DB, REPO, 'merge', { session: 's-1' })).rejects.toThrow(
      /^Gate passed;[\s\S]*\nThe merge lock at \/lock was gone or replaced/,
    );
  });

  it('refuses a land off a declared sandbox before landing anything', async () => {
    vi.mocked(sandboxLabel).mockImplementationOnce(() => {
      throw new UndeclaredSandboxError();
    });

    await expect(runAction(DB, REPO, 'land', { session: 's-1' })).rejects.toThrow(
      UndeclaredSandboxError,
    );
    expect(landSession).not.toHaveBeenCalled();
  });
});

describe('confirmations', () => {
  it('asks before exactly kill, merge, land and debt close', () => {
    expect([...CONFIRMED_ACTIONS].sort()).toEqual(['debt-close', 'kill', 'land', 'merge']);
  });

  it('names what will run, the debt accepted included', () => {
    expect(confirmationText('kill', { session: 's-1' })).toContain('Kill session s-1?');
    expect(
      confirmationText('merge', {
        session: 's-1',
        reason: 'one feature',
        reviewBy: 'q1',
        approver: 'tg:ana',
      }),
    ).toBe(
      'Gate session s-1 and open its pull request, accepting what the gate flags as debt ("one feature", review by q1, accepted by tg:ana)?',
    );
    expect(confirmationText('debt-close', { id: '4' })).toContain('Close ledger entry #4?');
  });
});

describe('answerForms', () => {
  it('offers each option as one button sending its number, the recommended one marked, then words', () => {
    const html = answerForms('s-1', { options: ['rebase', '<b>merge</b>'], recommended: 2 });

    expect(html).toContain('<button type="submit" name="reply" value="1">1. rebase</button>');
    expect(html).toContain(
      '<button type="submit" name="reply" value="2" class="recommended">2. &lt;b&gt;merge&lt;/b&gt; (recommended)</button>',
    );
    expect(html).toContain('<input type="hidden" name="target" value="s-1">');
    expect(html).toContain('<input type="text" name="reply"');
    expect(html).not.toContain('<b>');
  });
});
