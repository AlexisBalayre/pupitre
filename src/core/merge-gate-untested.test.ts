import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  killSession: vi.fn(),
  steerPane: vi.fn(),
}));

// Without this, every merging test would spawn a real `claude -p` call.
vi.mock('../claude/utility.service.js', () => ({
  runUtility: vi.fn(() => ({ ok: false, output: 'mocked out in tests' })),
}));

import {
  commitIn,
  debtAdapter,
  initRepo,
  SESSION_ID,
  seedSession,
  sh,
  untimed,
} from '@test/helpers/merge-gate.mock.js';
import type { Adapter } from '../adapters/types/adapter.types.js';
import { openStore } from './db.client.js';
import { globToRegExp } from './glob.utils.js';
import { DUPLICATION_RULE_ID, UNTESTED_PATH_GLOBS } from './merge-gate.constants.js';
import { runMergeGate } from './merge-gate.service.js';
import { getProject, saveProjectBaseline } from './session.repository.js';
import { HELD_SLOT_ENV } from './test-slot.service.js';

describe('the test stage on a change no test reads (decision 139)', { timeout: 20_000 }, () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openStore(':memory:');
    repo = initRepo();
    // As inside a slot already held, so a gate here never queues behind the
    // machine's real test runs (decision 96).
    vi.stubEnv(HELD_SLOT_ENV, 'merge-gate-untested.test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A suite that always fails and a coverage run that counts, so a skip is the only pass. */
  const failingSuite = () => {
    const coverage = vi.fn(() => ({ files: {} }));
    const adapter: Adapter = debtAdapter({
      gateCommands: () => [
        { stage: 'build', command: 'true', args: [] },
        { stage: 'test', command: 'false', args: [] },
        { stage: 'lint', command: 'true', args: [] },
      ],
      coverage,
    });
    return { adapter, coverage };
  };

  const merge = (adapter: Adapter) =>
    runMergeGate(db, { repoPath: repo, sessionId: SESSION_ID, adapters: [adapter] });

  const testStage = (stages: { stage: string; status: string }[]) =>
    stages.find((stage) => stage.stage === 'test');

  it('skips the test and coverage stages and runs every other one', async () => {
    const worktree = seedSession(db, repo, { scopeIn: ['**'] });
    commitIn(worktree, '.github/workflows/ci.yml', 'on: push\n');
    commitIn(worktree, 'docs/adr/0001-a.md', '# 0001. A\n');
    const { adapter, coverage } = failingSuite();

    const outcome = await merge(adapter);

    expect(outcome.status).toBe('merged');
    const skipped = { status: 'skipped', detail: 'no testable file changed (2 files)' };
    const stages = untimed(outcome.report.stages);
    expect(stages).toContainEqual({ stage: 'test', ...skipped });
    expect(stages).toContainEqual({ stage: 'coverage', ...skipped });
    expect(stages.map((stage) => stage.stage)).toEqual([
      'worktree-clean',
      'fresh-base',
      'build',
      'test',
      'lint',
      'scope-audit',
      'diff-size',
      'dead-code',
      'duplication',
      'complexity',
      'coverage',
    ]);
    expect(stages.filter((stage) => stage.status === 'pass').map((stage) => stage.stage)).toEqual(
      expect.arrayContaining(['build', 'lint', 'scope-audit', 'diff-size']),
    );
    expect(coverage).not.toHaveBeenCalled();
  });

  /** Build and lint only: no test command, and coverage only if `overrides` adds it. */
  const untestedAdapter = (overrides: Partial<Adapter> = {}): Adapter =>
    debtAdapter({
      gateCommands: () => [
        { stage: 'build', command: 'true', args: [] },
        { stage: 'lint', command: 'true', args: [] },
      ],
      ...overrides,
    });
  const notMeasured = { status: 'skipped', detail: 'not measured — no command available' };

  it('names each stage by what could have measured it when there is no test command', async () => {
    const worktree = seedSession(db, repo, { scopeIn: ['**'] });
    commitIn(worktree, '.github/workflows/ci.yml', 'on: push\n');
    const coverage = vi.fn(() => ({ files: {} }));

    const outcome = await merge(untestedAdapter({ coverage }));

    const stages = untimed(outcome.report.stages);
    expect(stages).toContainEqual({ stage: 'test', ...notMeasured });
    expect(stages).toContainEqual({
      stage: 'coverage',
      status: 'skipped',
      detail: 'no testable file changed (1 files)',
    });
    expect(coverage).not.toHaveBeenCalled();
  });

  /** The coverage stage judgeCoverage gives an adapter that cannot measure it, on any change. */
  const cannotMeasureCoverage = {
    stage: 'coverage',
    status: 'skipped',
    detail: 'not measured — adapter cannot measure coverage',
  };

  it('keeps the usual coverage reason with neither a test command nor coverage', async () => {
    const worktree = seedSession(db, repo, { scopeIn: ['**'] });
    commitIn(worktree, '.github/workflows/ci.yml', 'on: push\n');

    const outcome = await merge(untestedAdapter());

    const stages = untimed(outcome.report.stages);
    expect(stages).toContainEqual({ stage: 'test', ...notMeasured });
    expect(stages).toContainEqual(cannotMeasureCoverage);
  });

  it('skips the test stage and keeps the usual coverage reason without coverage', async () => {
    const worktree = seedSession(db, repo, { scopeIn: ['**'] });
    commitIn(worktree, '.github/workflows/ci.yml', 'on: push\n');
    const adapter = debtAdapter({
      gateCommands: () => [
        { stage: 'build', command: 'true', args: [] },
        { stage: 'test', command: 'false', args: [] },
        { stage: 'lint', command: 'true', args: [] },
      ],
    });

    const outcome = await merge(adapter);

    expect(outcome.status).toBe('merged');
    const stages = untimed(outcome.report.stages);
    expect(stages).toContainEqual({
      stage: 'test',
      status: 'skipped',
      detail: 'no testable file changed (1 files)',
    });
    expect(stages).toContainEqual(cannotMeasureCoverage);
  });

  it('runs the full test stage when one changed file is off the list', async () => {
    const worktree = seedSession(db, repo, { scopeIn: ['**'] });
    commitIn(worktree, '.github/workflows/ci.yml', 'on: push\n');
    commitIn(worktree, 'src/app.ts', 'export const app = 2;\n');

    const outcome = await merge(failingSuite().adapter);

    expect(outcome.status).toBe('rejected');
    expect(testStage(outcome.report.stages)?.status).toBe('fail');
  });

  it('runs the test stage when a source file is renamed onto a listed path', async () => {
    const worktree = seedSession(db, repo, { scopeIn: ['**'] });
    sh(worktree, 'mkdir', 'docs');
    sh(worktree, 'git', 'mv', 'src/app.ts', 'docs/app.md');
    sh(worktree, 'git', 'commit', '-m', 'move');

    const outcome = await merge(failingSuite().adapter);

    expect(testStage(outcome.report.stages)?.status).toBe('fail');
  });

  it('runs the test stage when a Docusaurus config compiles the changed Markdown', async () => {
    commitIn(repo, 'docusaurus.config.ts', 'export default {};\n');
    const worktree = seedSession(db, repo, { scopeIn: ['**'] });
    commitIn(worktree, 'docs/guide.md', '# guide\n');

    const outcome = await merge(failingSuite().adapter);

    expect(testStage(outcome.report.stages)?.status).toBe('fail');
  });

  it('runs the test stage when a symlink reaches the changed path', async () => {
    commitIn(repo, 'docs/notes.md', '# notes\n');
    symlinkSync('../docs/notes.md', join(repo, 'src/notes.md'));
    sh(repo, 'git', 'add', '.');
    sh(repo, 'git', 'commit', '-m', 'link');
    const worktree = seedSession(db, repo, { scopeIn: ['**'] });
    commitIn(worktree, 'docs/notes.md', '# notes, edited\n');

    const outcome = await merge(failingSuite().adapter);

    expect(testStage(outcome.report.stages)?.status).toBe('fail');
  });

  it('leaves the coverage baseline as it was, while the other metrics ratchet', async () => {
    const worktree = seedSession(db, repo, { scopeIn: ['**'] });
    saveProjectBaseline(
      db,
      'proj-1',
      ['fake'],
      JSON.stringify({
        capturedAt: 'now',
        adapters: ['fake'],
        stages: [],
        debt: { duplicationRule: DUPLICATION_RULE_ID, coverageRatio: 0.8 },
      }),
    );
    commitIn(worktree, '.github/workflows/ci.yml', 'on: push\n');

    const outcome = await merge(failingSuite().adapter);

    expect(outcome.status).toBe('merged');
    const { debt } = JSON.parse(getProject(db, 'proj-1')?.baseline ?? '{}');
    // The ratchet ran: the dead-code findings are new, and coverage kept its bar.
    expect(debt).toMatchObject({ deadExports: [], coverageRatio: 0.8 });
  });

  /**
   * Commits `path` spelled exactly as given, which a case-insensitive
   * filesystem would otherwise fold onto a path the tree already holds.
   */
  const commitSpelled = (dir: string, path: string, content: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
    const blob = sh(dir, 'git', 'hash-object', '-w', '--', path).trim();
    sh(dir, 'git', 'update-index', '--add', '--cacheinfo', `100644,${blob},${path}`);
    sh(dir, 'git', 'commit', '-m', `add ${path}`);
  };

  it('runs the test stage when the tree holds the changed path in another case', async () => {
    commitIn(repo, 'docs/x.MD', '# x\n');
    const worktree = seedSession(db, repo, { scopeIn: ['**'] });
    // The same bytes, so the folded working tree stays clean.
    commitSpelled(worktree, 'docs/x.md', '# x\n');

    const outcome = await merge(failingSuite().adapter);

    expect(testStage(outcome.report.stages)?.status).toBe('fail');
  });

  it('runs the test stage when the tree holds a directory of it in another case', async () => {
    commitIn(repo, 'Docs/guide.md', '# guide\n');
    const worktree = seedSession(db, repo, { scopeIn: ['**'] });
    commitSpelled(worktree, 'docs/adr/0001-a.md', '# 0001. A\n');

    const outcome = await merge(failingSuite().adapter);

    expect(testStage(outcome.report.stages)?.status).toBe('fail');
  });

  /** Moves `from` to `to` in the index only, so a case-folding filesystem keeps every spelling. */
  const renameSpelled = (dir: string, from: string, to: string) => {
    writeFileSync(join(dir, to), readFileSync(join(dir, from)));
    sh(dir, 'git', 'update-index', '--force-remove', '--', from);
    sh(dir, 'git', 'update-index', '--add', '--', to);
    sh(dir, 'git', 'commit', '-m', `move ${from}`);
  };

  // `--name-only` names a rename by its new path, but the old one is what a
  // link or another case reached on the target.
  it('runs the test stage when a symlink reaches a renamed path', async () => {
    commitIn(repo, 'docs/notes.md', '# notes\n');
    symlinkSync('../docs/notes.md', join(repo, 'src/notes.md'));
    sh(repo, 'git', 'add', '.');
    sh(repo, 'git', 'commit', '-m', 'link');
    const worktree = seedSession(db, repo, { scopeIn: ['**'] });
    sh(worktree, 'git', 'mv', 'docs/notes.md', 'docs/notes-old.md');
    sh(worktree, 'git', 'commit', '-m', 'move');

    const outcome = await merge(failingSuite().adapter);

    expect(testStage(outcome.report.stages)?.status).toBe('fail');
  });

  it('runs the test stage when a renamed path folds onto another in the tree', async () => {
    commitIn(repo, 'docs/x.MD', '# x\n');
    commitSpelled(repo, 'docs/x.md', '# x\n');
    const worktree = seedSession(db, repo, { scopeIn: ['**'] });
    renameSpelled(worktree, 'docs/x.md', 'docs/y.md');

    const outcome = await merge(failingSuite().adapter);

    expect(testStage(outcome.report.stages)?.status).toBe('fail');
  });

  // A session can write the shared config, and a `core.worktree` aimed at `/`
  // gives an unpinned tree read a cwd prefix no branch path matches.
  describe('when the shared config aims core.worktree elsewhere', () => {
    const aimedAway = (worktree: string) => sh(worktree, 'git', 'config', 'core.worktree', '/');

    it('still sees a symlink reach the changed path', async () => {
      commitIn(repo, 'docs/notes.md', '# notes\n');
      symlinkSync('../docs/notes.md', join(repo, 'src/notes.md'));
      sh(repo, 'git', 'add', '.');
      sh(repo, 'git', 'commit', '-m', 'link');
      const worktree = seedSession(db, repo, { scopeIn: ['**'] });
      commitIn(worktree, 'docs/notes.md', '# notes, edited\n');
      aimedAway(worktree);

      const outcome = await merge(failingSuite().adapter);

      expect(testStage(outcome.report.stages)?.status).toBe('fail');
    });

    it('still sees the tree hold the changed path in another case', async () => {
      commitIn(repo, 'docs/x.MD', '# x\n');
      const worktree = seedSession(db, repo, { scopeIn: ['**'] });
      commitSpelled(worktree, 'docs/x.md', '# x\n');
      aimedAway(worktree);

      const outcome = await merge(failingSuite().adapter);

      expect(testStage(outcome.report.stages)?.status).toBe('fail');
    });

    it('still sees a dependency file name Docusaurus', async () => {
      commitIn(repo, 'package.json', '{ "dependencies": { "@docusaurus/core": "3.0.0" } }\n');
      const worktree = seedSession(db, repo, { scopeIn: ['**'] });
      commitIn(worktree, 'docs/guide.md', '# guide\n');
      aimedAway(worktree);

      const outcome = await merge(failingSuite().adapter);

      expect(testStage(outcome.report.stages)?.status).toBe('fail');
    });
  });
});

const ANCHOR = String.raw`process\.cwd\(\)|import\.meta\.dirname|__dirname`;
// A quoted string, or a template with no `${`; \x60 is the backquote.
const LITERAL = String.raw`(?:'([^'\\\n]*)'|"([^"\\\n]*)"|\x60([^\x60\\$]*)\x60)`;

/** Every string literal in `text`, in order. */
function literalsIn(text: string): string[] {
  return [...text.matchAll(new RegExp(LITERAL, 'g'))].map(
    ([, single, double, tick]) => (single ?? double ?? tick) as string,
  );
}

/** The argument text of the call whose `(` sits at `open`, to its matching `)`. */
function callArgs(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const char = text[i] as string;
    if (char === "'" || char === '"' || char === '`') {
      const end = text.indexOf(char, i + 1);
      i = end === -1 ? text.length : end;
    } else if ('([{'.includes(char)) {
      depth++;
    } else if (')]}'.includes(char) && --depth === 0) {
      return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

/** The callee and `(` of the innermost call around `at`, through any array or object. */
function enclosingCall(text: string, at: number): { callee: string; open: number } | undefined {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const char = text[i] as string;
    if (')]}'.includes(char)) depth++;
    else if ('([{'.includes(char)) {
      if (depth > 0) depth--;
      else if (char === '(') {
        const callee = /[\w$.]+$/.exec(text.slice(Math.max(0, i - 80), i))?.[0];
        if (callee) return { callee: callee.split('.').at(-1) as string, open: i };
      }
    }
  }
  return undefined;
}

/**
 * Every path, relative to the repo root, that the source `text` of `file`
 * reads from the real checkout rather than from a temp repo. vitest runs at
 * the root, so a read reaches the checkout through an anchor or a path
 * relative to the root or to the file:
 * - a call holding `process.cwd()`, `import.meta.dirname` or `__dirname`, or a
 *   name declared as one: each literal in it, and for `join` and `resolve`
 *   the path they build, including a `cwd:` option to a spawn;
 * - a template string starting with an anchor;
 * - a literal starting with `./` or `../`, as every import, `require`,
 *   `vi.mock`, `new URL(…, import.meta.url)` and `?raw` import spells one,
 *   resolved from the file;
 * - `import.meta.glob` from the root;
 * - an fs, glob or path call (`readFileSync`, `accessSync`, `opendirSync`,
 *   `fs.promises.*`, `globSync`, an unanchored `resolve` or `join`, …) whose
 *   first argument is a relative literal;
 * - a spawn (`execFileSync`, `spawnSync`, …) with no `cwd` and no `-C`, whose
 *   literals, `git ls-files docs` among them, name paths from the root.
 *
 * A path built only from an anchor and a variable is left out: what the
 * variable holds came from a read this does name, such as a walk of `src`.
 */
function readsIn(file: string, text: string): string[] {
  const reads: string[] = [];
  const add = (base: string, ...segments: string[]) => {
    const path = posix.join(base, ...segments.map((segment) => segment.replace(/[?#].*$/, '')));
    if (path !== '.' && !path.startsWith('../')) reads.push(path);
  };
  const fileDir = dirname(file);
  const anchorBase = (anchor: string): string => (anchor === 'process.cwd()' ? '' : fileDir);
  // A name declared as an anchor, or as a join or resolve from one, is one too.
  const bases = new Map<string, string>();
  for (const [, name = '', anchor = '', run = ''] of text.matchAll(
    new RegExp(
      String.raw`(?:const|let|var)\s+(\w+)\s*=\s*(?:(?:path\.|posix\.)*(?:join|resolve)\(\s*)?(${ANCHOR})((?:\s*,\s*${LITERAL})*)`,
      'g',
    ),
  )) {
    bases.set(name, posix.join(anchorBase(anchor), ...literalsIn(run)));
  }
  const names = [...bases.keys()].map((name) => String.raw`\b${name}\b`);
  const anchors = new RegExp([ANCHOR, ...names].join('|'), 'g');
  for (const match of text.matchAll(anchors)) {
    const base = bases.get(match[0]) ?? anchorBase(match[0]);
    const call = enclosingCall(text, match.index);
    if (!call || call.callee === 'cwd') continue;
    const args = callArgs(text, call.open);
    const offset = match.index - call.open - 1;
    if (call.callee === 'join' || call.callee === 'resolve') {
      const after = literalsIn(args.slice(offset));
      if (after.length > 0) add(base, ...after);
    } else {
      for (const literal of literalsIn(args)) add(base, literal);
    }
  }
  for (const [, anchor = '', rest = ''] of text.matchAll(
    new RegExp(String.raw`\$\{(${ANCHOR})\}\/([^\x60$]*)`, 'g'),
  )) {
    add(anchorBase(anchor), rest);
  }
  for (const literal of literalsIn(text)) {
    if (literal.startsWith('./') || literal.startsWith('../')) add(fileDir, literal);
  }
  for (const [, ...spelled] of text.matchAll(
    new RegExp(String.raw`import\.meta\.glob\(\s*${LITERAL}`, 'g'),
  )) {
    const path = spelled.find((value) => value !== undefined) as string;
    if (path.startsWith('/')) add('', path.slice(1));
  }
  const fsCall = new RegExp(
    String.raw`\b(read\w*|access\w*|opendir\w*|l?stat\w*|exists\w*|open\w*|createReadStream|copyFile\w*|cp|cpSync|realpath\w*|readlink\w*|watch\w*|glob|globSync|globStream|fg|resolve|join)\(\s*${LITERAL}`,
    'g',
  );
  for (const match of text.matchAll(fsCall)) {
    const [callee = ''] = match.slice(1, 2);
    const first = match.slice(2).find((value) => value !== undefined) as string;
    if (first.startsWith('/')) continue;
    const open = (match.index as number) + match[0].indexOf('(');
    if (callee === 'join' || callee === 'resolve') {
      const segments = literalsIn(callArgs(text, open));
      add('', ...segments);
    } else {
      add('', first);
    }
  }
  for (const match of text.matchAll(/\b(?:exec\w*|spawn\w*|fork|execa)\(/g)) {
    const args = callArgs(text, (match.index as number) + match[0].length - 1);
    if (/\bcwd\b/.test(args) || literalsIn(args).includes('-C')) continue;
    for (const literal of literalsIn(args)) add('', literal);
  }
  return reads;
}

/**
 * Every file the suite loads: the TypeScript under `src/`, whatever the vitest
 * config's `include` collects, and that config itself.
 */
function suiteFiles(root: string): string[] {
  const config = 'vitest.config.ts';
  const include = /include:\s*\[([^\]]*)\]/.exec(readFileSync(join(root, config), 'utf8'))?.[1];
  const globs = ['src/**/*.ts', ...literalsIn(include ?? '')];
  const files = new Set<string>([config]);
  for (const glob of globs) {
    const matcher = globToRegExp(glob);
    const segments = glob.split('/');
    const firstWild = segments.findIndex((segment) => /[*?[{]/.test(segment));
    const top = segments.slice(0, firstWild === -1 ? segments.length : firstWild).join('/');
    let entries: string[];
    try {
      entries = readdirSync(join(root, top), { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const rel of entries) {
      const path = posix.join(top, rel);
      if (!path.includes('node_modules/') && matcher.test(path)) files.add(path);
    }
  }
  return [...files];
}

/**
 * Every path the suite reads from the checkout, by `readsIn`. This file is
 * left out: its table of read forms names listed files on purpose, its own
 * walks read only `src/`, the vitest config and the roots the list names, and
 * no assertion names a listed file.
 */
function checkoutReads(): string[] {
  const root = process.cwd();
  const self = 'src/core/merge-gate-untested.test.ts';
  return suiteFiles(root)
    .filter((file) => file !== self)
    .flatMap((file) => readsIn(file, readFileSync(join(root, file), 'utf8')));
}

/** Every file in this checkout on `UNTESTED_PATH_GLOBS`, found under the roots the globs name. */
function listedFiles(): string[] {
  const root = process.cwd();
  const untested = UNTESTED_PATH_GLOBS.map(globToRegExp);
  const tops = [...new Set(UNTESTED_PATH_GLOBS.map((glob) => glob.split('/')[0] as string))];
  const files: string[] = [];
  for (const top of tops) {
    let isDir: boolean;
    try {
      isDir = statSync(join(root, top)).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) {
      files.push(top);
      continue;
    }
    for (const rel of readdirSync(join(root, top), { recursive: true }) as string[]) {
      files.push(posix.join(top, rel));
    }
  }
  return files.filter((file) => untested.some((glob) => glob.test(file)));
}

describe('UNTESTED_PATH_GLOBS against what the suite reads (decision 139)', () => {
  const file = 'src/core/a.test.ts';

  it.each([
    ['an anchored join', "readFileSync(join(process.cwd(), 'CLAUDE.md'))", 'CLAUDE.md'],
    [
      'a join from the file',
      "readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'adr', 'x.md'))",
      'docs/adr/x.md',
    ],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text a test would hold
    ['an anchored template', 'readFileSync(`${process.cwd()}/AGENTS.md`)', 'AGENTS.md'],
    [
      'an aliased anchor',
      "const root = process.cwd();\nreadFileSync(join(root, 'LICENSE'))",
      'LICENSE',
    ],
    ['a URL from the module', "new URL('../../LICENSE', import.meta.url)", 'LICENSE'],
    ['a ?raw import', "import adr from '../../docs/adr/x.md?raw';", 'docs/adr/x.md'],
    ['a dynamic import', "await import('../../CONTRIBUTING.md')", 'CONTRIBUTING.md'],
    ['a require', "require('../../docs/02-cli.md')", 'docs/02-cli.md'],
    ['an unanchored resolve', "readFileSync(resolve('docs/02-cli.md'))", 'docs/02-cli.md'],
    ['an accessSync', "accessSync('CLAUDE.md')", 'CLAUDE.md'],
    ['an opendirSync', "opendirSync('docs/adr')", 'docs/adr'],
    [
      'a promises read',
      "await fs.promises.readFile('.github/workflows/ci.yml')",
      '.github/workflows/ci.yml',
    ],
    ['a glob', "globSync('docs/**/*.md')", 'docs/**/*.md'],
    ['a vite glob', "import.meta.glob('/docs/adr/*.md')", 'docs/adr/*.md'],
    ['git ls-files', "execFileSync('git', ['ls-files', 'docs/adr'])", 'docs/adr'],
    [
      'a spawn in the checkout',
      "execFileSync('cat', ['CLAUDE.md'], { cwd: process.cwd() })",
      'CLAUDE.md',
    ],
  ])('names the path %s reads', (_form, text, path) => {
    expect(readsIn(file, text)).toContain(path);
  });

  it('names nothing a temp repo spells', () => {
    expect(
      readsIn(
        file,
        [
          "commitIn(worktree, 'docs/adr/0001-a.md', '# A');",
          "readFileSync(join(repo, 'CLAUDE.md'));",
          "execFileSync('git', ['add', 'docs'], { cwd: repo });",
          "execFileSync('git', ['-C', repo, 'add', 'docs']);",
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('holds no file and no directory any file the suite loads reads from the checkout', () => {
    const reads = checkoutReads();
    const listed = listedFiles();
    // Neither side is vacuous: the suite's real reads are seen, and the list
    // matches files this checkout holds. No listed file is named, so a change
    // that deletes or renames one, which the gate lets skip this test, cannot
    // break it.
    expect(reads).toEqual(
      expect.arrayContaining(['scripts/pre-commit', 'src', 'src/core/sandbox.utils.ts']),
    );
    expect(listed.length).toBeGreaterThan(0);
    const readListed = reads.flatMap((path) => {
      const glob = /[*?]/.test(path) ? globToRegExp(path) : undefined;
      return listed
        .filter((file) => (glob ? glob.test(file) : file === path || file.startsWith(`${path}/`)))
        .map((file) => ({ path, file }));
    });
    expect(readListed).toEqual([]);
  });
});
