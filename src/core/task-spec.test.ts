import { describe, expect, it } from 'vitest';
import { assertPlannableSpec, scopeInFiles } from './task-spec.utils.js';
import type { TaskId, TaskSpec, TaskTicket, TicketType } from './types/profile.types.js';

describe('scopeInFiles (decision 128)', () => {
  const NO_DEADLINE = Number.POSITIVE_INFINITY;
  const tracked = [
    'src/core/land.service.ts',
    'src/core/land.test.ts',
    'src/core/landing/inner.ts',
    'src/core/legacy/land.ts',
    '.claude/settings.json',
  ];

  it('returns the tracked files the scope-in matches, in tracked order', () => {
    expect(scopeInFiles(tracked, { scopeIn: ['src/core/land*.ts'] }, NO_DEADLINE)).toEqual({
      files: ['src/core/land.service.ts', 'src/core/land.test.ts'],
      toCreate: [],
    });
  });

  it('drops what scope-out takes back and the protected paths, as the gate does', () => {
    const scope = scopeInFiles(
      tracked,
      {
        scopeIn: ['src/core/**', '.claude/**'],
        scopeOut: ['src/core/legacy/**'],
      },
      NO_DEADLINE,
    );

    expect(scope?.files).toEqual([
      'src/core/land.service.ts',
      'src/core/land.test.ts',
      'src/core/landing/inner.ts',
    ]);
  });

  it('names a glob that matches no tracked path as one to create, and ignores blank globs', () => {
    expect(
      scopeInFiles(
        tracked,
        { scopeIn: ['src/core/land.ts', ' ', 'src/core/land.test.ts'] },
        NO_DEADLINE,
      ),
    ).toEqual({
      files: ['src/core/land.test.ts'],
      toCreate: ['src/core/land.ts'],
    });
  });

  // `pup new --scope` stores a glob as typed; globToRegExp trims it and drops a leading `./`.
  it('offers for creation a new file whose glob is ./-prefixed or space-padded', () => {
    expect(
      scopeInFiles(
        tracked,
        {
          scopeIn: ['./src/core/new.ts', ' src/core/other.ts ', './.claude/new.md'],
          scopeOut: [],
        },
        NO_DEADLINE,
      ),
    ).toEqual({ files: [], toCreate: ['./src/core/new.ts', ' src/core/other.ts '] });
  });

  // The hook would refuse what it names, so it is neither listed nor offered for creation.
  it('never offers for creation a glob only protected or scope-out paths answer', () => {
    expect(
      scopeInFiles(
        tracked,
        {
          scopeIn: [
            'src/core/legacy/*.ts',
            'src/core/legacy/new.ts',
            '.claude/**',
            '.claude/new.md',
          ],
          scopeOut: ['src/core/legacy/**'],
        },
        NO_DEADLINE,
      ),
    ).toEqual({ files: [], toCreate: [] });
  });

  // The listing is the repo's, which a session can plant to be huge.
  it('gives up once its deadline passes', () => {
    expect(scopeInFiles(tracked, { scopeIn: ['src/**'] }, Date.now() - 1)).toBeUndefined();
  });
});

describe('assertPlannableSpec with a ticket (decision 187)', () => {
  const spec = (ticket: Partial<TaskTicket>): TaskSpec => ({
    id: 't-1' as TaskId,
    goal: 'g',
    scopeIn: ['src/**'],
    acceptance: ['a'],
    ticket: {
      ref: '#412',
      type: 'feature',
      labels: ['ready'],
      triggers: [],
      criteria: [],
      ...ticket,
    },
  });

  it('refuses a feature without the design-approved label: it has a design by default', () => {
    expect(() => assertPlannableSpec(spec({}))).toThrow(
      'Ticket #412 has no design-approved label, and its type, feature, has a design by default: ' +
        'the operator validates its design before a slice of it starts.',
    );
  });

  it('takes a feature the operator approved the design of', () => {
    expect(() => assertPlannableSpec(spec({ labels: ['ready', 'design-approved'] }))).not.toThrow();
  });

  it.each(['bug', 'chore', 'refactor', 'docs', 'spike', 'follow-up'] as const)(
    'takes a %s no trigger fired on without the label: it needs no design',
    (type) => {
      expect(() => assertPlannableSpec(spec({ type }))).not.toThrow();
    },
  );

  it('refuses a type with no design by default once a trigger fired, naming the triggers', () => {
    expect(() =>
      assertPlannableSpec(spec({ type: 'bug', triggers: ['adr-area', 'module-boundary'] })),
    ).toThrow(
      'Ticket #412 has no design-approved label, and design triggers fired on it ' +
        '(adr-area, module-boundary)',
    );
    expect(() =>
      assertPlannableSpec(
        spec({ type: 'bug', triggers: ['dependency'], labels: ['design-approved'] }),
      ),
    ).not.toThrow();
  });

  // A type intake does not know yet needs the label, as a feature does.
  it('refuses a type it does not know without the label', () => {
    expect(() => assertPlannableSpec(spec({ type: 'epic' as TicketType }))).toThrow(
      'its type, epic, has a design by default',
    );
  });

  // The refusal is printed by every caller; a string in it is scrubbed to one line.
  it('scrubs the type and the triggers into the refusal', () => {
    expect(() =>
      assertPlannableSpec(spec({ type: 'ep\u001b[2Jic' as TicketType, triggers: [] })),
    ).toThrow('its type, ep [2Jic, has a design by default');
    expect(() => assertPlannableSpec(spec({ type: 'bug', triggers: ['adr\narea'] }))).toThrow(
      'design triggers fired on it (adr area)',
    );
  });

  it('checks no ticket on a task that has none', () => {
    const { ticket: _, ...plain } = spec({});
    expect(() => assertPlannableSpec(plain)).not.toThrow();
  });

  const approved = (ticket: Partial<TaskTicket>) =>
    spec({ labels: ['design-approved'], ...ticket });

  it.each(['#412', '412', 'octo-org/my.repo_2#412'])('takes the tracker reference %j', (ref) => {
    expect(() => assertPlannableSpec(approved({ ref }))).not.toThrow();
  });

  // The reference heads the kickoff's ticket section: nothing but a tracker's
  // reference may reach it.
  it.each([
    '',
    '#',
    '#412 ',
    '#1\n## Goal',
    '#1 ## Goal',
    'owner/repo#',
    'owner#412',
    '#12345678901',
    '\u2028#412',
  ])('refuses the reference %j', (ref) => {
    expect(() => assertPlannableSpec(approved({ ref }))).toThrow(
      'is not a tracker reference such as #412 or owner/repo#412.',
    );
  });

  it('takes a ticket at every cap', () => {
    expect(() =>
      assertPlannableSpec(
        approved({
          type: 'f'.repeat(30) as TicketType,
          design: 'd'.repeat(8_000),
          labels: ['design-approved', ...Array.from({ length: 29 }, () => 'l'.repeat(50))],
          triggers: Array.from({ length: 10 }, () => 't'.repeat(50)),
          criteria: Array.from({ length: 20 }, () => 'c'.repeat(500)),
        }),
      ),
    ).not.toThrow();
  });

  it.each<[string, Partial<TaskTicket>, string]>([
    ['type', { type: 'f'.repeat(31) as TicketType }, 'its type is over 30 characters'],
    ['design note', { design: 'd'.repeat(8_001) }, 'its design note is over 8000 characters'],
    [
      'label count',
      { labels: ['design-approved', ...Array.from({ length: 30 }, () => 'l')] },
      'it has over 30 labels',
    ],
    [
      'label length',
      { labels: ['design-approved', 'l'.repeat(51)] },
      'one of its labels is over 50 characters',
    ],
    ['trigger count', { triggers: Array.from({ length: 11 }, () => 't') }, 'over 10 triggers'],
    ['trigger length', { triggers: ['t'.repeat(51)] }, 'one of its triggers is over 50 characters'],
    ['criteria count', { criteria: Array.from({ length: 21 }, () => 'c') }, 'over 20 criteria'],
    [
      'criterion length',
      { criteria: ['c'.repeat(501)] },
      'one of its criteria is over 500 characters',
    ],
  ])('refuses a ticket over its %s cap, naming it', (_, over, reason) => {
    const check = () => assertPlannableSpec(approved(over));
    expect(check).toThrow('Ticket #412 is over a cap: ');
    expect(check).toThrow(reason);
  });

  it('names every cap a ticket is over at once', () => {
    expect(() =>
      assertPlannableSpec(approved({ design: 'd'.repeat(8_001), criteria: ['c'.repeat(501)] })),
    ).toThrow(
      'Ticket #412 is over a cap: its design note is over 8000 characters; ' +
        'one of its criteria is over 500 characters.',
    );
  });
});
