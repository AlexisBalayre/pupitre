import { describe, expect, it } from 'vitest';
import { LADDERS } from '../claude/model-ladder.constants.js';
import { globToRegExp } from './glob.utils.js';
import {
  asTier,
  CRITICAL_AREAS,
  climbFrom,
  globsIntersect,
  nextRung,
  routeFor,
  taskTier,
  tierForScope,
  windowFailure,
} from './routing.utils.js';
import type { SessionEvent } from './types/session-event.types.js';

describe('tierForScope', () => {
  it.each([
    'src/core/merge-gate.service.ts',
    'src/core/merge-gate.test.ts',
    'src/core/land.service.ts',
    'src/core/regate.service.ts',
    'src/core/sandbox-profile.utils.ts',
    'src/core/profile-compiler.service.ts',
    'src/core/session.repository.ts',
    'src/core/db.client.ts',
    'src/core/migrations/0001-routing.sql',
    'src/core/git-diff.client.ts',
    'src/claude/session-runtime.service.ts',
    '.claude/hooks/git-safety.sh',
    '.github/workflows/ci.yml',
  ])('makes a scope naming %s critical', (path) => {
    expect(tierForScope(['docs/adr/', path])).toBe('critical');
  });

  // A glob is critical when it CAN name a critical file, whether or not the
  // task means to: the hook lets the session edit anything the glob matches.
  it.each([
    ['src/**'],
    ['**/*.ts'],
    ['src/core/*.ts'],
    ['src/core/'],
    ['src/core/session*.ts'],
    ['src/core/*.test.ts'],
    ['.claude/**'],
    ['**/hooks/*.sh'],
  ])('makes the broad glob %s critical', (glob) => {
    expect(tierForScope([glob])).toBe('critical');
  });

  it.each([
    [['src/cli/ui/**']],
    [['docs/**', 'README.md']],
    [['src/cli/index.ts', 'src/cli/index.test.ts']],
    [['skills/pup/**']],
    [['src/core/dashboard.service.ts', 'src/core/dashboard.test.ts']],
    [['src/core/session-repository.test.ts']],
    [['src/core/web-dashboard.service.ts', 'src/core/routing.utils.ts']],
  ])('leaves the UI, docs and CLI wording scope %j standard', (scope) => {
    expect(tierForScope(scope)).toBe('standard');
  });

  it('is standard for an empty scope', () => {
    expect(tierForScope([])).toBe('standard');
  });
});

describe('globsIntersect', () => {
  it.each([
    ['src/**', 'src/core/db.client.ts', true],
    ['src/core/*.test.ts', 'src/core/*.repository.ts', false],
    ['src/core/*.test.ts', 'src/core/merge-gate*', true],
    ['src/*/x.ts', 'src/core/**', true],
    ['src/core/**/x.ts', 'src/core/x.ts', true],
    ['src/cli/**', 'src/claude/**', false],
    ['src/c*/**', '.github/**', false],
    ['./src/core/land.service.ts', 'src/core/land*', true],
    ['src/core/la?d.ts', 'src/core/land*', true],
    ['src/core/la?d.ts', 'src/core/lend*', false],
    ['src/core/lan', 'src/core/land*', false],
    ['docs/', 'docs/a/b.md', true],
  ])('%s and %s -> %s', (left, right, expected) => {
    expect(globsIntersect(left, right)).toBe(expected);
    expect(globsIntersect(right, left)).toBe(expected);
  });

  // Soundness against the matcher the hook enforces with: whenever one real
  // path matches both globs, the two must be said to intersect.
  it('never misses an intersection a sample path witnesses', () => {
    const globs = [
      ...CRITICAL_AREAS,
      'src/**',
      'src/core/*.ts',
      'src/core/session*',
      '**/*.test.ts',
      'src/cli/ui/**',
      'docs/**',
      '**/x',
      'src/core/**/x.ts',
    ];
    const paths = [
      'src/core/merge-gate.service.ts',
      'src/core/session.repository.ts',
      'src/core/session-repository.test.ts',
      'src/core/migrations/a/b.sql',
      'src/core/x.ts',
      'src/core/deep/x.ts',
      'src/claude/x',
      'src/cli/ui/app.component.tsx',
      '.claude/hooks/a.sh',
      '.github/x',
      'docs/x',
    ];
    for (const left of globs) {
      for (const right of globs) {
        const witnessed = paths.some(
          (path) => globToRegExp(left).test(path) && globToRegExp(right).test(path),
        );
        if (witnessed)
          expect([left, right, globsIntersect(left, right)]).toEqual([left, right, true]);
      }
    }
  });
});

describe('asTier', () => {
  it('reads back a stored tier and nothing else', () => {
    expect(asTier('critical')).toBe('critical');
    expect(asTier('standard')).toBe('standard');
    expect(asTier('Critical')).toBeUndefined();
    expect(asTier(null)).toBeUndefined();
  });
});

describe('taskTier', () => {
  it('takes the stored tier over the scope, and the scope when none is stored', () => {
    expect(taskTier('standard', ['src/core/merge-gate.service.ts'])).toBe('standard');
    expect(taskTier('critical', ['docs/**'])).toBe('critical');
    expect(taskTier(null, ['src/core/merge-gate.service.ts'])).toBe('critical');
    expect(taskTier('bogus', ['docs/**'])).toBe('standard');
  });

  // A spec read for display is store text: a torn glob is skipped, not thrown on.
  it('reads only the globs that are strings', () => {
    expect(taskTier(null, ['docs/**', 7, null])).toBe('standard');
    expect(taskTier(null, [7, 'src/claude/**'])).toBe('critical');
  });
});

const rejected: SessionEvent = { type: 'gate_result', from: 'awaiting-review', to: 'rejected' };
const blocked: SessionEvent = { type: 'gate_result', from: 'rejected', to: 'blocked' };
const regated: SessionEvent = { type: 'gate_result', from: 'merged', to: 'merged' };
const died: SessionEvent = { type: 'turn_died', reason: 'API Error', stalledAt: 'x' };
const respawned: SessionEvent = { type: 'other', eventType: 'respawn', fields: {} };
const steered: SessionEvent = { type: 'steer', kind: 'gate-rejection' };

describe('windowFailure', () => {
  it('names the first failure of the window', () => {
    expect(windowFailure([steered, rejected, died])).toBe('gate-rejection');
    expect(windowFailure([died, rejected])).toBe('turn-death');
    expect(windowFailure([regated])).toBe('ci-fix-round');
  });

  it('is nothing for a window that ran into nothing', () => {
    expect(windowFailure([])).toBeUndefined();
    expect(windowFailure([steered, { type: 'gate_result', from: 'running', to: 'merged' }])).toBe(
      undefined,
    );
  });

  it('counts only what came after the newest respawn', () => {
    expect(windowFailure([rejected, respawned])).toBeUndefined();
    expect(windowFailure([rejected, respawned, died])).toBe('turn-death');
  });

  it('lets a block win over every failure, so a parked task never climbs', () => {
    expect(windowFailure([rejected, rejected, blocked])).toBe('blocked');
    expect(windowFailure([blocked, died])).toBe('blocked');
    expect(windowFailure([blocked], true)).toBe('blocked');
  });

  // No event records a stall: the caller says whether the window ended in one.
  it('names a stall the window ended in, after every failure its events record', () => {
    expect(windowFailure([steered], true)).toBe('stall');
    expect(windowFailure([rejected, respawned], true)).toBe('stall');
    expect(windowFailure([died], true)).toBe('turn-death');
    expect(windowFailure([steered], false)).toBeUndefined();
  });
});

describe('climbFrom', () => {
  const window = (tier: string | null, rung: number | null, rung_reason: string | null = null) => ({
    tier,
    rung,
    rung_reason,
  });

  it('starts on the bottom rung with no window before', () => {
    expect(climbFrom('standard', undefined, undefined)).toEqual({ rung: 0 });
  });

  it('climbs one rung from the window before after a failure, recording why', () => {
    expect(climbFrom('standard', window('standard', 1), 'stall')).toEqual({
      rung: 2,
      reason: 'stall',
    });
  });

  it('stays where the window before stood, keeping why it got there, after nothing or a block', () => {
    const climbed = window('standard', 2, 'gate-rejection');
    expect(climbFrom('standard', climbed, undefined)).toEqual({
      rung: 2,
      reason: 'gate-rejection',
    });
    expect(climbFrom('standard', climbed, 'blocked')).toEqual({
      rung: 2,
      reason: 'gate-rejection',
    });
  });

  // A re-tiered task, and a window launched before routing, have no rung on this ladder.
  it('starts from the bottom when the window before ran on another tier or none', () => {
    expect(climbFrom('critical', window('standard', 3), 'gate-rejection')).toEqual({ rung: 0 });
    expect(climbFrom('standard', window(null, null), 'turn-death')).toEqual({ rung: 0 });
    expect(climbFrom('standard', window('standard', null), 'turn-death')).toEqual({ rung: 0 });
  });

  it('marks a failure on the top rung as reached, standing on the top rung', () => {
    expect(climbFrom('critical', window('critical', 1, 'stall'), 'ci-fix-round')).toEqual({
      rung: 1,
      reason: 'stall',
      topReached: 'ci-fix-round',
    });
  });
});

describe('routeFor', () => {
  it("is the rung's model, effort and fallback with no override", () => {
    expect(routeFor('standard', 0)).toEqual({
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      fallbackModel: 'claude-opus-5-5',
    });
    expect(routeFor('critical', 1)).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh' });
  });

  it("puts an operator's model or effort over the rung's, the fallback only behind the rung's model", () => {
    expect(routeFor('standard', 1, { effort: 'low' })).toEqual({
      model: 'claude-sonnet-5-5',
      effort: 'low',
      fallbackModel: 'claude-opus-5-5',
    });
    expect(routeFor('standard', 1, { model: 'claude-haiku-5-5' })).toEqual({
      model: 'claude-haiku-5-5',
      effort: 'high',
    });
  });

  it('clamps a rung outside the ladder into it', () => {
    expect(routeFor('critical', 7)).toEqual(LADDERS.critical[1]);
    expect(routeFor('standard', -1)).toEqual(LADDERS.standard[0]);
  });
});

describe('nextRung', () => {
  it('climbs exactly one rung after a failure, recording why', () => {
    expect(nextRung('standard', 0, 'gate-rejection')).toEqual({
      rung: 1,
      reason: 'gate-rejection',
    });
    expect(nextRung('standard', 2, 'stall')).toEqual({ rung: 3, reason: 'stall' });
    expect(nextRung('critical', 0, 'ci-fix-round')).toEqual({ rung: 1, reason: 'ci-fix-round' });
  });

  it('stays on its rung with no failure, and after a block', () => {
    expect(nextRung('standard', 1, undefined)).toEqual({ rung: 1 });
    expect(nextRung('standard', 1, 'blocked')).toEqual({ rung: 1 });
  });

  it('hands a failure on the top rung back for the operator instead of climbing', () => {
    expect(nextRung('standard', LADDERS.standard.length - 1, 'turn-death')).toEqual({
      topReached: 'turn-death',
    });
    expect(nextRung('critical', 1, 'gate-rejection')).toEqual({ topReached: 'gate-rejection' });
  });

  it('clamps a stored rung outside the ladder into it', () => {
    expect(nextRung('critical', 9, undefined)).toEqual({ rung: 1 });
    expect(nextRung('standard', -2, undefined)).toEqual({ rung: 0 });
    expect(nextRung('standard', 1.5, 'stall')).toEqual({ rung: 1, reason: 'stall' });
  });
});
