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

describe('assertPlannableSpec with a ticket (decision 186)', () => {
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

  it('checks no ticket on a task that has none', () => {
    const { ticket: _, ...plain } = spec({});
    expect(() => assertPlannableSpec(plain)).not.toThrow();
  });
});
