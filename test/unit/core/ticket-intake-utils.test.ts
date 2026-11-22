import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkTicketIntake, type IntakeContext } from '@src/core/ticket-intake.utils.js';
import { describe, expect, it } from 'vitest';

const NO_ADR: IntakeContext = { adrAreas: [] };

/** An issue body as GitHub issue forms render it: one `###` heading per field. */
function body(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([heading, value]) => `### ${heading}\n\n${value}`)
    .join('\n\n');
}

const FEATURE = {
  Goal: 'Let the operator pause a ticket from the queue.',
  'Acceptance criteria': '- Pausing keeps the slice list\n- A paused ticket launches nothing',
  'Out of scope': 'Pausing a live session.',
  'Affected area': '`src/core/queue.service.ts`',
};

describe('checkTicketIntake required fields', () => {
  it('names a missing feature field', () => {
    const { 'Out of scope': _, ...rest } = FEATURE;
    const result = checkTicketIntake(body(rest), 'feature', NO_ADR);
    expect(result.missing).toEqual(['Out of scope']);
    expect(result.vague).toEqual([]);
  });

  it('names a missing bug field', () => {
    const result = checkTicketIntake(
      body({ Reproduction: 'Run `pup ls` with no tasks.', 'Suspected area': 'src/cli' }),
      'bug',
      NO_ADR,
    );
    expect(result.missing).toEqual(['Expected against actual']);
  });

  it.each(['chore', 'refactor'] as const)('names a missing %s field', (type) => {
    const result = checkTicketIntake(
      body({ 'Scope boundary': 'Only the queue store.', 'Files in scope': 'src/core/queue.ts' }),
      type,
      NO_ADR,
    );
    expect(result.missing).toEqual(['Proof behavior is unchanged']);
  });

  it('names a missing docs field', () => {
    const result = checkTicketIntake(body({ Goal: 'Better docs.' }), 'docs', NO_ADR);
    expect(result.missing).toEqual(['What changes']);
  });

  it('names a missing spike field', () => {
    const result = checkTicketIntake(
      body({ Question: 'Can the gate share a cache?', 'Time box': '2h' }),
      'spike',
      NO_ADR,
    );
    expect(result.missing).toEqual(['Form of the answer']);
  });

  it('names a missing follow-up field', () => {
    const result = checkTicketIntake(
      body({ 'Source PR': '#412', Findings: '- A minor naming issue', Scenarios: 'Empty queue.' }),
      'follow-up',
      NO_ADR,
    );
    expect(result.missing).toEqual(['Original reviewers']);
  });

  it('matches a heading whatever its level, case and punctuation', () => {
    const text = Object.entries(FEATURE)
      .map(([heading, value]) => `## ${heading.toUpperCase()}:\n${value}`)
      .join('\n');
    expect(checkTicketIntake(text, 'feature', NO_ADR).missing).toEqual([]);
  });
});

describe('checkTicketIntake vague fields', () => {
  it.each([
    ['an empty value', ''],
    ['the issue form placeholder', '_No response_'],
    ['TBD', 'TBD'],
    ['an angle-bracket placeholder', '<describe the goal>'],
    ['one word', 'Pausing'],
    ['an empty list item', '- Pausing keeps the slice list\n- '],
    ['an empty checkbox item', '- [ ]'],
  ])('counts %s as vague', (_, value) => {
    const result = checkTicketIntake(body({ ...FEATURE, Goal: value }), 'feature', NO_ADR);
    expect(result.vague).toEqual(['Goal']);
    expect(result.missing).toEqual([]);
  });

  it('accepts one word where a reference answers the field', () => {
    const result = checkTicketIntake(
      body({
        'Source PR': '#412',
        Findings: '- A minor naming issue',
        Scenarios: 'Empty queue.',
        'Original reviewers': '@reviewer',
      }),
      'follow-up',
      NO_ADR,
    );
    expect(result).toMatchObject({ missing: [], vague: [] });
  });

  it('still counts a placeholder as vague in a field one word answers', () => {
    const result = checkTicketIntake(
      body({ ...FEATURE, 'Affected area': 'n/a' }),
      'feature',
      NO_ADR,
    );
    expect(result.vague).toEqual(['Affected area']);
  });
});

describe('checkTicketIntake design', () => {
  const BUG = {
    Reproduction: 'Run `pup ls` with no tasks.',
    'Expected against actual': 'An empty table, not a crash.',
    'Suspected area': 'src/cli/ls.command.ts',
  };

  it('gives a feature a design with no trigger', () => {
    const result = checkTicketIntake(body(FEATURE), 'feature', NO_ADR);
    expect(result).toEqual({ missing: [], vague: [], triggers: [], needsDesign: true });
  });

  it('gives another type no design when nothing fires', () => {
    const result = checkTicketIntake(body(BUG), 'bug', NO_ADR);
    expect(result).toEqual({ missing: [], vague: [], triggers: [], needsDesign: false });
  });

  it('forces a design on a path in an ADR area', () => {
    const result = checkTicketIntake(body(BUG), 'bug', { adrAreas: ['src/cli/**'] });
    expect(result).toMatchObject({ triggers: ['adr-area'], needsDesign: true });
  });

  it('forces a design when the area crosses a module boundary', () => {
    const result = checkTicketIntake(
      body({ ...BUG, 'Suspected area': 'src/cli/ls.command.ts and src/core/queue.service.ts' }),
      'bug',
      NO_ADR,
    );
    expect(result).toMatchObject({ triggers: ['module-boundary'], needsDesign: true });
  });

  it('keeps a module and its tests inside one module', () => {
    const result = checkTicketIntake(
      body({ ...BUG, 'Suspected area': 'src/cli/ls.ts, test/unit/cli/ls.test.ts' }),
      'bug',
      NO_ADR,
    );
    expect(result.triggers).toEqual([]);
  });

  it.each([
    ['a checked dependency box', { ...BUG, Extras: '- [x] Adds a dependency' }],
    ['package.json in the area', { ...BUG, 'Suspected area': 'package.json' }],
  ])('forces a design on %s', (_, fields) => {
    const result = checkTicketIntake(body(fields), 'bug', NO_ADR);
    expect(result).toMatchObject({ triggers: ['dependency'], needsDesign: true });
  });

  it('ignores an unchecked dependency box', () => {
    const result = checkTicketIntake(
      body({ ...BUG, Extras: '- [ ] Adds a dependency' }),
      'bug',
      NO_ADR,
    );
    expect(result.triggers).toEqual([]);
  });

  it('forces a design on an estimate over the size cap, not at it', () => {
    const over = checkTicketIntake(body({ ...BUG, Estimate: '1,200 lines' }), 'bug', NO_ADR);
    const at = checkTicketIntake(body({ ...BUG, Estimate: '600 lines' }), 'bug', NO_ADR);
    expect(over).toMatchObject({ triggers: ['size'], needsDesign: true });
    expect(at).toMatchObject({ triggers: [], needsDesign: false });
  });

  it('reads the whole body for triggers on a type with no area field', () => {
    const result = checkTicketIntake(
      body({
        'Source PR': '#412',
        Findings: '- Rename in src/core/a.ts\n- Guard in src/adapters/b.ts',
        Scenarios: 'Empty queue.',
        'Original reviewers': '@reviewer',
      }),
      'follow-up',
      NO_ADR,
    );
    expect(result).toMatchObject({ triggers: ['module-boundary'], needsDesign: true });
  });
});

describe('checkTicketIntake purity', () => {
  it('imports nothing that reads a file or runs a process', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'src', 'core', 'ticket-intake.utils.ts'),
      'utf8',
    );
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports).toEqual(['./glob.utils.js', './types/profile.types.js']);
  });
});
