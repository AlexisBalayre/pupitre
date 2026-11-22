import { describe, expect, it } from 'vitest';
import { LADDERS } from '../claude/constants/model-ladder.constants.js';
import { Tier } from '../claude/enums/tier.enums.js';
import { ClimbReason } from './enums/climb-reason.enums.js';
import { EventType } from './enums/event-type.enums.js';
import { globToRegExp } from './glob.utils.js';
import {
  asTier,
  CRITICAL_AREAS,
  climbFrom,
  fixRoundFailure,
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
    expect(tierForScope(['docs/adr/', path])).toBe(Tier.Critical);
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
    expect(tierForScope([glob])).toBe(Tier.Critical);
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
    expect(tierForScope(scope)).toBe(Tier.Standard);
  });

  it('is standard for an empty scope', () => {
    expect(tierForScope([])).toBe(Tier.Standard);
  });

  // The areas match by path: a file extracted out of a critical area into
  // `src/core/{types,constants,errors,enums}/` stays critical for the tier
  // (decision 92) and for a remeasure's approval (decision 185).
  it.each([
    'src/core/constants/merge-gate.constants.ts',
    'src/core/errors/merge-gate.errors.ts',
    'src/core/types/merge-gate.types.ts',
    'src/core/enums/merge-status.enums.ts',
    'src/core/enums/gate-stage-status.enums.ts',
    'src/core/types/land.types.ts',
    'src/core/types/regate.types.ts',
    'src/core/errors/sandbox.errors.ts',
    'src/core/types/sandbox.types.ts',
    'src/core/enums/sandbox-mode.enums.ts',
    'src/core/enums/interrupt-signal.enums.ts',
    'src/core/types/profile-compiler.types.ts',
    'src/core/types/session.types.ts',
    'src/core/enums/session-state.enums.ts',
    'src/core/enums/event-type.enums.ts',
    'src/core/errors/session.errors.ts',
    'src/core/types/ledger.types.ts',
    'src/core/types/baseline-history.types.ts',
    'src/core/types/decision-record.types.ts',
    'src/core/errors/git-diff.errors.ts',
    'src/core/types/git-diff.types.ts',
    'src/core/types/github.types.ts',
  ])('keeps %s, moved out of a critical area, critical', (path) => {
    expect(tierForScope([path])).toBe(Tier.Critical);
    expect(CRITICAL_AREAS.map(globToRegExp).some((area) => area.test(path))).toBe(true);
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
    expect(asTier(Tier.Critical)).toBe(Tier.Critical);
    expect(asTier(Tier.Standard)).toBe(Tier.Standard);
    expect(asTier('Critical')).toBeUndefined();
    expect(asTier(null)).toBeUndefined();
  });
});

describe('taskTier', () => {
  it('takes the stored tier over the scope, and the scope when none is stored', () => {
    expect(taskTier(Tier.Standard, ['src/core/merge-gate.service.ts'])).toBe(Tier.Standard);
    expect(taskTier(Tier.Critical, ['docs/**'])).toBe(Tier.Critical);
    expect(taskTier(null, ['src/core/merge-gate.service.ts'])).toBe(Tier.Critical);
    expect(taskTier('bogus', ['docs/**'])).toBe(Tier.Standard);
  });

  // A spec read for display is store text: a torn glob is skipped, not thrown on.
  it('reads only the globs that are strings', () => {
    expect(taskTier(null, ['docs/**', 7, null])).toBe(Tier.Standard);
    expect(taskTier(null, [7, 'src/claude/**'])).toBe(Tier.Critical);
  });
});

const rejected: SessionEvent = { type: 'gate_result', from: 'awaiting-review', to: 'rejected' };
const blocked: SessionEvent = { type: 'gate_result', from: 'rejected', to: 'blocked' };
const regated: SessionEvent = { type: 'gate_result', from: 'merged', to: 'merged' };
const died: SessionEvent = { type: 'turn_died', reason: 'API Error', stalledAt: 'x' };
const respawned: SessionEvent = { type: 'other', eventType: EventType.Respawn, fields: {} };
const steered: SessionEvent = { type: 'steer', kind: 'gate-rejection' };

describe('windowFailure', () => {
  it('names the first failure of the window', () => {
    expect(windowFailure([steered, rejected, died])).toBe(ClimbReason.GateRejection);
    expect(windowFailure([died, rejected])).toBe(ClimbReason.TurnDeath);
  });

  it('is nothing for a window that ran into nothing', () => {
    expect(windowFailure([])).toBeUndefined();
    expect(windowFailure([steered, { type: 'gate_result', from: 'running', to: 'merged' }])).toBe(
      undefined,
    );
  });

  // A reviewer's finding is no failure of capability: only a repeat climbs, by fixRoundFailure.
  it('takes no re-gate after a CI fix round for a failure', () => {
    expect(windowFailure([regated])).toBeUndefined();
    expect(windowFailure([regated, died])).toBe(ClimbReason.TurnDeath);
  });

  it('counts only what came after the newest respawn', () => {
    expect(windowFailure([rejected, respawned])).toBeUndefined();
    expect(windowFailure([rejected, respawned, died])).toBe(ClimbReason.TurnDeath);
  });

  it('lets a block win over every failure, so a parked task never climbs', () => {
    expect(windowFailure([rejected, rejected, blocked])).toBe('blocked');
    expect(windowFailure([blocked, died])).toBe('blocked');
    expect(windowFailure([blocked], true)).toBe('blocked');
  });

  // No event records a stall: the caller says whether the window ended in one.
  it('names a stall the window ended in, after every failure its events record', () => {
    expect(windowFailure([steered], true)).toBe(ClimbReason.Stall);
    expect(windowFailure([rejected, respawned], true)).toBe(ClimbReason.Stall);
    expect(windowFailure([died], true)).toBe(ClimbReason.TurnDeath);
    expect(windowFailure([steered], false)).toBeUndefined();
  });
});

describe('fixRoundFailure', () => {
  const round = (...threads: string[]): SessionEvent => ({
    type: 'other',
    eventType: EventType.FixRound,
    fields: { threads },
  });
  const opened = (delivered: boolean): SessionEvent => ({
    type: 'other',
    eventType: EventType.Respawn,
    fields: { delivered },
  });
  const merge: SessionEvent = { type: 'merge', files: [] };
  const killed: SessionEvent = { type: 'gate_result', from: 'running', to: 'merged' };

  it('is nothing on a first round, whatever the window before it ran into', () => {
    expect(fixRoundFailure([merge])).toBeUndefined();
    expect(fixRoundFailure([steered, rejected, died, merge])).toBeUndefined();
  });

  // The review mints fresh thread ids on every head a round pushes, so a
  // re-raised finding never shares one: the round itself is the repeat.
  it('names a repeat for a round after any one a merge ended, whatever its threads', () => {
    const first = [merge, round('T1'), opened(true), regated, merge];
    expect(fixRoundFailure(first)).toBe(ClimbReason.RepeatFixRound);
    expect(fixRoundFailure([...first, round('T2'), opened(true), regated, merge])).toBe(
      ClimbReason.RepeatFixRound,
    );
    // A re-gate after the head moved ends no round, and undoes no repeat.
    expect(fixRoundFailure([merge, round('T1'), opened(true), merge, merge])).toBe(
      ClimbReason.RepeatFixRound,
    );
  });

  // Its kickoff never landed, so it never ran.
  it('passes over a round undone before its window opened', () => {
    expect(fixRoundFailure([merge, round('T1'), opened(false), killed, merge])).toBeUndefined();
    const retried = [merge, round('T1'), opened(true), merge, round('T2'), opened(false), killed];
    expect(fixRoundFailure(retried)).toBe(ClimbReason.RepeatFixRound);
  });

  // Its window recorded the repeat climb when its kickoff landed.
  it('climbs the retry of a killed round only on what its window ran into', () => {
    const ran = [merge, round('T1'), opened(true), merge, round('T2'), opened(true)];
    expect(fixRoundFailure([...ran, killed])).toBeUndefined();
    expect(fixRoundFailure([...ran, rejected, killed])).toBe(ClimbReason.GateRejection);
    expect(fixRoundFailure([...ran, died, killed])).toBe(ClimbReason.TurnDeath);
    expect(fixRoundFailure([merge, round('T1'), opened(true), died, killed])).toBe(
      ClimbReason.TurnDeath,
    );
  });

  // The undone retry stored no route, so the next one still answers the window that ran.
  it('keeps the failure of a killed round across a retry undone before its window opened', () => {
    const undone = [round('T1'), opened(false), killed];
    const ran = [merge, round('T1'), opened(true)];
    expect(fixRoundFailure([...ran, died, killed, ...undone])).toBe(ClimbReason.TurnDeath);
    expect(fixRoundFailure([...ran, rejected, killed, ...undone])).toBe(ClimbReason.GateRejection);
  });

  // A `pup respawn` opens its window and stores its climb even when its kickoff never lands.
  it('counts only what came after a respawn of the round, delivered or not', () => {
    const ran = [merge, round('T1'), opened(true), died];
    expect(fixRoundFailure([...ran, opened(false), killed])).toBeUndefined();
    expect(fixRoundFailure([...ran, opened(false), rejected, killed])).toBe(
      ClimbReason.GateRejection,
    );
  });
});

describe('climbFrom', () => {
  const window = (tier: string | null, rung: number | null, rung_reason: string | null = null) => ({
    tier,
    rung,
    rung_reason,
  });

  it('starts on the bottom rung with no window before', () => {
    expect(climbFrom(Tier.Standard, undefined, undefined)).toEqual({ rung: 0 });
  });

  it('climbs one rung from the window before after a failure, recording why', () => {
    expect(climbFrom(Tier.Standard, window(Tier.Standard, 1), ClimbReason.Stall)).toEqual({
      rung: 2,
      reason: ClimbReason.Stall,
    });
  });

  it('stays where the window before stood, keeping why it got there, after nothing or a block', () => {
    const climbed = window(Tier.Standard, 2, ClimbReason.GateRejection);
    expect(climbFrom(Tier.Standard, climbed, undefined)).toEqual({
      rung: 2,
      reason: ClimbReason.GateRejection,
    });
    expect(climbFrom(Tier.Standard, climbed, 'blocked')).toEqual({
      rung: 2,
      reason: ClimbReason.GateRejection,
    });
  });

  // A re-tiered task, and a window launched before routing, have no rung on this ladder.
  it('starts from the bottom when the window before ran on another tier or none', () => {
    expect(climbFrom(Tier.Critical, window(Tier.Standard, 3), ClimbReason.GateRejection)).toEqual({
      rung: 0,
    });
    expect(climbFrom(Tier.Standard, window(null, null), ClimbReason.TurnDeath)).toEqual({
      rung: 0,
    });
    expect(climbFrom(Tier.Standard, window(Tier.Standard, null), ClimbReason.TurnDeath)).toEqual({
      rung: 0,
    });
  });

  it('marks a failure on the top rung as reached, standing on the top rung', () => {
    expect(
      climbFrom(
        Tier.Critical,
        window(Tier.Critical, 1, ClimbReason.Stall),
        ClimbReason.RepeatFixRound,
      ),
    ).toEqual({
      rung: 1,
      reason: ClimbReason.Stall,
      topReached: ClimbReason.RepeatFixRound,
    });
  });
});

describe('routeFor', () => {
  it("is the rung's model, effort and fallback with no override", () => {
    expect(routeFor(Tier.Standard, 0)).toEqual({
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      fallbackModel: 'claude-opus-5-5',
    });
    expect(routeFor(Tier.Critical, 1)).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh' });
  });

  it("puts an operator's model or effort over the rung's, the fallback only behind the rung's model", () => {
    expect(routeFor(Tier.Standard, 1, { effort: 'low' })).toEqual({
      model: 'claude-sonnet-5-5',
      effort: 'low',
      fallbackModel: 'claude-opus-5-5',
    });
    expect(routeFor(Tier.Standard, 1, { model: 'claude-haiku-5-5' })).toEqual({
      model: 'claude-haiku-5-5',
      effort: 'high',
    });
  });

  it('clamps a rung outside the ladder into it', () => {
    expect(routeFor(Tier.Critical, 7)).toEqual(LADDERS[Tier.Critical][1]);
    expect(routeFor(Tier.Standard, -1)).toEqual(LADDERS[Tier.Standard][0]);
  });
});

describe('nextRung', () => {
  it('climbs exactly one rung after a failure, recording why', () => {
    expect(nextRung(Tier.Standard, 0, ClimbReason.GateRejection)).toEqual({
      rung: 1,
      reason: ClimbReason.GateRejection,
    });
    expect(nextRung(Tier.Standard, 2, ClimbReason.Stall)).toEqual({
      rung: 3,
      reason: ClimbReason.Stall,
    });
    expect(nextRung(Tier.Critical, 0, ClimbReason.RepeatFixRound)).toEqual({
      rung: 1,
      reason: ClimbReason.RepeatFixRound,
    });
  });

  it('stays on its rung with no failure, and after a block', () => {
    expect(nextRung(Tier.Standard, 1, undefined)).toEqual({ rung: 1 });
    expect(nextRung(Tier.Standard, 1, 'blocked')).toEqual({ rung: 1 });
  });

  it('hands a failure on the top rung back for the operator instead of climbing', () => {
    expect(
      nextRung(Tier.Standard, LADDERS[Tier.Standard].length - 1, ClimbReason.TurnDeath),
    ).toEqual({
      topReached: ClimbReason.TurnDeath,
    });
    expect(nextRung(Tier.Critical, 1, ClimbReason.GateRejection)).toEqual({
      topReached: ClimbReason.GateRejection,
    });
  });

  it('clamps a stored rung outside the ladder into it', () => {
    expect(nextRung(Tier.Critical, 9, undefined)).toEqual({ rung: 1 });
    expect(nextRung(Tier.Standard, -2, undefined)).toEqual({ rung: 0 });
    expect(nextRung(Tier.Standard, 1.5, ClimbReason.Stall)).toEqual({
      rung: 1,
      reason: ClimbReason.Stall,
    });
  });
});
