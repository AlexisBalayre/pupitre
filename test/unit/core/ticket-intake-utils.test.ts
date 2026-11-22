import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkTicketIntake, type IntakeContext } from '@src/core/ticket-intake.utils.js';
import type { TicketType } from '@src/core/types/profile.types.js';
import { describe, expect, it } from 'vitest';

const NO_ADR: IntakeContext = { adrAreas: [] };

const ROOT = join(import.meta.dirname, '..', '..', '..');

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

const BUG = {
  Reproduction: 'Run `pup ls` with no tasks.',
  'Expected against actual': 'An empty table, not a crash.',
  'Suspected area': 'src/cli/ls.command.ts',
};

const REFACTOR = {
  'Scope boundary': 'Only the plan service.',
  'Proof that behavior is unchanged': 'The plan service tests pass unchanged.',
  'Files in scope': 'src/core/plan.service.ts',
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
    expect(result.missing).toEqual(['Proof that behavior is unchanged']);
  });

  it('names a missing docs field', () => {
    const result = checkTicketIntake(
      body({
        'What changes, or the question': 'The rubric says ready comes first.',
        'Form of the answer': 'docs/tickets/bug.md',
      }),
      'docs',
      NO_ADR,
    );
    expect(result.missing).toEqual(['Time box']);
  });

  it('names a missing spike field', () => {
    const result = checkTicketIntake(
      body({ 'What changes, or the question': 'Can the gate share a cache?', 'Time box': '2h' }),
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
      .map(([heading, value]) => `## ${heading.toUpperCase()}: ##\n${value}`)
      .join('\n');
    expect(checkTicketIntake(text, 'feature', NO_ADR).missing).toEqual([]);
  });

  it.each([
    ['feature', 'feature'],
    ['bug', 'bug'],
    ['chore', 'chore-refactor'],
    ['refactor', 'chore-refactor'],
    ['docs', 'docs-spike'],
    ['spike', 'docs-spike'],
    ['follow-up', 'follow-up'],
  ] as [TicketType, string][])('finds every %s field under its %s.yml form label', (type, form) => {
    const yaml = readFileSync(join(ROOT, '.github', 'ISSUE_TEMPLATE', `${form}.yml`), 'utf8');
    const labels = [...yaml.matchAll(/^\s+label:\s*(.+?)\s*$/gm)].map((match) =>
      (match[1] ?? '').replace(/^(['"])(.*)\1$/, '$2'),
    );
    const filled = Object.fromEntries(labels.map((label) => [label, 'Filled in for the test.']));
    expect(checkTicketIntake(body(filled), type, NO_ADR)).toMatchObject({ missing: [], vague: [] });
  });

  it('reads no heading inside a code fence', () => {
    const result = checkTicketIntake(
      body({ ...BUG, Reproduction: '```sh\n# fresh clone\npup ls\n```' }),
      'bug',
      NO_ADR,
    );
    expect(result).toMatchObject({ missing: [], vague: [] });
  });

  it('opens no fence on a line of inline code', () => {
    const result = checkTicketIntake(
      body({ ...BUG, Reproduction: '```pup ls``` with no tasks.' }),
      'bug',
      NO_ADR,
    );
    expect(result).toMatchObject({ missing: [], vague: [] });
  });

  it('runs an unclosed fence to the end of the body', () => {
    const result = checkTicketIntake(
      body({ ...BUG, Reproduction: '```sh\npup ls' }),
      'bug',
      NO_ADR,
    );
    expect(result.missing).toEqual(['Expected against actual', 'Suspected area']);
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

  it.each(['n/a', 'TBD.', 'Unknown.', 'N/A.', '_TBD_', '`n/a`', '**none**'])(
    'still counts the placeholder %s as vague in a field one word answers',
    (value) => {
      const result = checkTicketIntake(
        body({ ...FEATURE, 'Affected area': value }),
        'feature',
        NO_ADR,
      );
      expect(result.vague).toEqual(['Affected area']);
    },
  );

  it('reads no empty list item in the added and removed blank lines of a fenced diff', () => {
    const result = checkTicketIntake(
      body({
        ...BUG,
        'Expected against actual':
          'Actual: the generated hook gains a block:\n```diff\n exit 0\n+\n+echo stale\n-\n```',
      }),
      'bug',
      NO_ADR,
    );
    expect(result).toMatchObject({ missing: [], vague: [] });
  });
});

describe('checkTicketIntake design', () => {
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

  it.each([
    ['a directory with a trailing slash', 'src/cli/'],
    ['a path under ./', './src/cli/ls.ts'],
  ])('forces a design on %s in an ADR area', (_, area) => {
    const result = checkTicketIntake(body({ ...BUG, 'Suspected area': area }), 'bug', {
      adrAreas: ['src/cli/**'],
    });
    expect(result).toMatchObject({ triggers: ['adr-area'], needsDesign: true });
  });

  it('forces a design when directories cross a module boundary', () => {
    const result = checkTicketIntake(
      body({ ...BUG, 'Suspected area': 'src/cli/ and src/core/' }),
      'bug',
      NO_ADR,
    );
    expect(result).toMatchObject({ triggers: ['module-boundary'], needsDesign: true });
  });

  it('reads the paths of a fenced area past a comment line', () => {
    const result = checkTicketIntake(
      body({
        ...BUG,
        'Suspected area': '```\n# from the stack trace\nsrc/core/a.ts\nsrc/cli/b.ts\n```',
      }),
      'bug',
      NO_ADR,
    );
    expect(result).toMatchObject({ triggers: ['module-boundary'], needsDesign: true });
  });

  it('reads the pages of a docs ticket for triggers', () => {
    const result = checkTicketIntake(
      body({
        'What changes, or the question': 'Say ready is applied first.',
        'Time box': '1h',
        'Form of the answer': 'docs/tickets/bug.md',
      }),
      'docs',
      { adrAreas: ['docs/tickets/**'] },
    );
    expect(result).toMatchObject({ missing: [], vague: [], triggers: ['adr-area'] });
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
    ['a test helper ending a sentence', 'src/core/land.service.ts and test/helpers/land.mock.ts.'],
    ['a wildcard of test helpers', 'src/core/land.service.ts, test/helpers/*'],
  ])('reads no module in %s', (_, area) => {
    const result = checkTicketIntake(body({ ...BUG, 'Suspected area': area }), 'bug', NO_ADR);
    expect(result.triggers).toEqual([]);
  });

  it('drops the period of a sentence that ends in a path', () => {
    const result = checkTicketIntake(
      body({ ...BUG, 'Suspected area': 'The crash is in src/cli/ls.command.ts.' }),
      'bug',
      { adrAreas: ['src/cli/*.ts'] },
    );
    expect(result).toMatchObject({ triggers: ['adr-area'], needsDesign: true });
  });

  it('reads no trigger in the paths a scope boundary leaves alone', () => {
    const result = checkTicketIntake(
      body({
        'Scope boundary': 'Only the plan service; src/cli/plan.command.ts stays as it is.',
        'Proof that behavior is unchanged': 'The plan service tests pass unchanged.',
        'Files in scope': 'src/core/plan.service.ts',
      }),
      'refactor',
      { adrAreas: ['src/cli/**'] },
    );
    expect(result).toEqual({ missing: [], vague: [], triggers: [], needsDesign: false });
  });

  it.each([
    ['a globstar under src', 'src/**/*.ts'],
    ['a wildcard in the module segment', 'src/*/index.ts'],
    ['a globstar over the whole repository', '**/*.ts'],
  ])('forces a design on %s, which reaches several modules and the ADR area', (_, glob) => {
    const result = checkTicketIntake(body({ ...REFACTOR, 'Files in scope': glob }), 'refactor', {
      adrAreas: ['src/claude/**'],
    });
    expect(result).toMatchObject({ triggers: ['adr-area', 'module-boundary'], needsDesign: true });
  });

  it.each([
    ['a file the glob matches', 'src/core/*.ts', 'src/core/plan.service.ts'],
    ['a glob the glob overlaps', 'src/core/**', 'src/core/*.ts'],
  ])('counts a glob in an ADR area holding %s', (_, glob, area) => {
    const result = checkTicketIntake(body({ ...REFACTOR, 'Files in scope': glob }), 'refactor', {
      adrAreas: [area],
    });
    expect(result).toMatchObject({ triggers: ['adr-area'], needsDesign: true });
  });

  it.each([
    ['refactor', REFACTOR, 'Files in scope', 'src/claude/*.ts', 'src/claude/hooks.ts'],
    ['bug', BUG, 'Suspected area', 'src/claude/', 'src/claude/hooks/**'],
  ] as const)(
    'forces a design on a %s area holding an ADR area',
    (type, fields, heading, area, adr) => {
      const result = checkTicketIntake(body({ ...fields, [heading]: area }), type, {
        adrAreas: [adr],
      });
      expect(result).toMatchObject({ triggers: ['adr-area'], needsDesign: true });
    },
  );

  it.each([
    ['a directory sharing a name prefix', 'src/cla'],
    ['a sibling directory', 'src/core/'],
    ['a glob in a sibling directory', 'src/core/*.ts'],
  ])('reads no ADR area in %s', (_, area) => {
    const result = checkTicketIntake(body({ ...BUG, 'Suspected area': area }), 'bug', {
      adrAreas: ['src/claude/hooks/**', 'src/claude/hooks.ts'],
    });
    expect(result.triggers).toEqual([]);
  });

  it.each([
    ['a blob permalink', 'https://github.com/acme/tool/blob/main/src/claude/hooks.ts#L12'],
    ['a tree permalink', 'https://github.com/acme/tool/tree/3d35d70/src/claude/'],
  ])('matches %s as the bare path', (_, area) => {
    const adrAreas = ['src/claude/hooks.ts', 'src/claude/**'];
    const bare = area.replace(/^https:\/\/github\.com\/[^/]+\/[^/]+\/[^/]+\/[^/]+\//, '');
    for (const adr of adrAreas) {
      const context = { adrAreas: [adr] };
      const linked = checkTicketIntake(body({ ...BUG, 'Suspected area': area }), 'bug', context);
      const plain = checkTicketIntake(body({ ...BUG, 'Suspected area': bare }), 'bug', context);
      expect(linked.triggers).toEqual(['adr-area']);
      expect(linked).toEqual(plain);
    }
  });

  it('reads one module and no ADR area in a glob inside one module', () => {
    const result = checkTicketIntake(
      body({ ...REFACTOR, 'Files in scope': 'src/core/**/*.ts' }),
      'refactor',
      { adrAreas: ['src/claude/**'] },
    );
    expect(result).toEqual({ missing: [], vague: [], triggers: [], needsDesign: false });
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

  it("reads a follow-up's findings for triggers", () => {
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

  it("reads no trigger in the input a follow-up's scenario runs", () => {
    const result = checkTicketIntake(
      body({
        'Source PR': '#412',
        Findings: '- [minor] src/core/plan.service.ts:88 the error names the path',
        Scenarios: '`pup plan add t-1 --scope src/claude/**` prints the path, not the task id.',
        'Original reviewers': '@reviewer',
      }),
      'follow-up',
      { adrAreas: ['src/claude/**'] },
    );
    expect(result).toEqual({ missing: [], vague: [], triggers: [], needsDesign: false });
  });
});

describe('checkTicketIntake on a body built to backtrack', () => {
  it.each([
    ['a heading line of spaces', `# a${' '.repeat(2_000)}b`],
    ['a dot run inside a path', body({ ...BUG, 'Suspected area': `a/${'.'.repeat(50_000)}x` })],
    ['a word with no slash', body({ ...BUG, 'Suspected area': 'a'.repeat(50_000) })],
    ['a hyphenated word', body({ ...BUG, 'Suspected area': 'a-'.repeat(25_000) })],
    ['a run of blank lines', body({ ...BUG, Reproduction: `Run it.${'\n'.repeat(50_000)}Again.` })],
  ])('reads %s in linear time', (_, text) => {
    const started = Date.now();
    checkTicketIntake(text, 'bug', NO_ADR);
    expect(Date.now() - started).toBeLessThan(500);
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
