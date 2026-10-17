import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

// Captures the utility's argv; nothing here may spawn a real `claude`.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(() => 'drafted\n') };
});

import { CONDUCTOR_ROUTE, LADDERS, type ModelRoute, TIERS } from './model-ladder.constants.js';
import { launchArgs } from './session-runtime.service.js';
import { runUtility } from './utility.service.js';

const WINDOW = { sessionId: 's-1', settingsPath: '/tmp/compiled/settings.json' };

function utilityArgv(): string[] {
  vi.mocked(execFileSync).mockClear();
  runUtility('draft the decision record');
  return (vi.mocked(execFileSync).mock.calls[0]?.[1] ?? []) as string[];
}

/** Every argv pup builds for a `claude` it chooses the model of. */
function everyBuiltArgv(): { label: string; argv: string[] }[] {
  const rungs = TIERS.flatMap((tier) =>
    LADDERS[tier].map((route, rung) => ({
      label: `${tier} rung ${rung}`,
      argv: launchArgs({ ...WINDOW, route }),
    })),
  );
  return [
    ...rungs,
    { label: 'conductor', argv: launchArgs({ ...WINDOW, route: CONDUCTOR_ROUTE }) },
    { label: 'utility', argv: utilityArgv() },
  ];
}

describe('the model ladders', () => {
  it('are exactly the ladders decision 92 names', () => {
    const sonnet = (effort: string): ModelRoute => ({
      model: 'claude-sonnet-5-5',
      effort,
      fallbackModel: 'claude-opus-5-5',
    });
    const opus = (effort: string): ModelRoute => ({ model: 'claude-opus-5-5', effort });
    expect(LADDERS).toEqual({
      standard: [sonnet('medium'), sonnet('high'), opus('high'), opus('xhigh')],
      critical: [opus('high'), opus('xhigh')],
    });
    expect(CONDUCTOR_ROUTE).toEqual(opus('high'));
  });

  // The operator's rule: pup never chooses a Fable model, nor the `max`
  // effort, anywhere. An explicit --model/--effort is the only way in.
  it('never builds an argv naming a Fable model or the max effort', () => {
    for (const { label, argv } of everyBuiltArgv()) {
      expect(argv.length, label).toBeGreaterThan(0);
      expect(
        argv.filter((arg) => /fable/i.test(arg)),
        label,
      ).toEqual([]);
      const effort = argv[argv.indexOf('--effort') + 1];
      expect(effort, label).toMatch(/^(low|medium|high|xhigh)$/);
      expect(argv[argv.indexOf('--model') + 1], label).toMatch(/^claude-(haiku|sonnet|opus)-5-5$/);
    }
  });
});

describe('runUtility', () => {
  it('runs on Haiku at low effort, named in the argv', () => {
    const argv = utilityArgv();

    expect(argv.slice(0, 6)).toEqual([
      '-p',
      'draft the decision record',
      '--model',
      'claude-haiku-5-5',
      '--effort',
      'low',
    ]);
    // Still read-only: the write and exec tools stay denied after the flags.
    const denied = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch'];
    expect(argv.slice(argv.indexOf('--disallowedTools') + 1)).toEqual(denied);
  });
});
