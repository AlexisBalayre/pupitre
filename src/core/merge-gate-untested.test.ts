import { readdirSync, readFileSync, statSync, symlinkSync } from 'node:fs';
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

import type { Adapter } from '../adapters/types/adapter.types.js';
import {
  commitIn,
  debtAdapter,
  initRepo,
  SESSION_ID,
  seedSession,
  sh,
  untimed,
} from '../test/helpers/merge-gate.mock.js';
import { openStore } from './db.client.js';
import { globToRegExp } from './glob.utils.js';
import { UNTESTED_PATH_GLOBS } from './merge-gate.constants.js';
import { runMergeGate } from './merge-gate.service.js';
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

  it('reports a missing test command as not measured, not as skipped for the change', async () => {
    const worktree = seedSession(db, repo, { scopeIn: ['**'] });
    commitIn(worktree, '.github/workflows/ci.yml', 'on: push\n');
    const adapter = debtAdapter({
      gateCommands: () => [
        { stage: 'build', command: 'true', args: [] },
        { stage: 'lint', command: 'true', args: [] },
      ],
    });

    const outcome = await merge(adapter);

    expect(untimed(outcome.report.stages)).toContainEqual({
      stage: 'test',
      status: 'skipped',
      detail: 'not measured — no command available',
    });
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
});

/**
 * Every path, relative to the repo root, that a TypeScript file under `src/`
 * reads from the real checkout rather than from a temp repo. vitest runs at
 * the root, so a read reaches the checkout in one of three ways: through
 * `process.cwd()`, `import.meta.dirname` or `__dirname` joined with literal
 * segments; through a `new URL` relative to `import.meta.url`; or through a
 * relative literal passed straight to an fs call. A read whose path is only
 * the anchor plus a variable is left out: what the variable holds came from a
 * read this does name, such as a walk of `src`.
 */
function checkoutReads(): string[] {
  const root = process.cwd();
  const sources = (readdirSync(join(root, 'src'), { recursive: true }) as string[])
    .filter((rel) => rel.endsWith('.ts'))
    .map((rel) => posix.join('src', rel));
  const literal = String.raw`(?:'([^'\\\n]*)'|"([^"\\\n]*)")`;
  const literalRun = new RegExp(literal, 'g');
  const anchored = new RegExp(
    String.raw`\b(?:join|resolve)\(\s*(process\.cwd\(\)|import\.meta\.dirname|__dirname)((?:\s*,\s*${literal})*)`,
    'g',
  );
  const templated = /\$\{(process\.cwd\(\)|import\.meta\.dirname|__dirname)\}\/([^`$]*)/g;
  const fromUrl = new RegExp(String.raw`new URL\(\s*${literal}\s*,\s*import\.meta\.url`, 'g');
  const relative = new RegExp(
    String.raw`\b(?:readFileSync|readdirSync|existsSync|statSync|lstatSync|readFile|createReadStream|copyFileSync|cpSync)\(\s*${literal}`,
    'g',
  );
  const reads: string[] = [];
  for (const file of sources) {
    const text = readFileSync(join(root, file), 'utf8');
    const base = (anchor: string): string => (anchor === 'process.cwd()' ? '' : dirname(file));
    for (const [, anchor = '', run = ''] of text.matchAll(anchored)) {
      const segments = [...run.matchAll(literalRun)].map(([, single, double]) => single ?? double);
      if (segments.length > 0) reads.push(posix.join(base(anchor), ...(segments as string[])));
    }
    for (const [, anchor = '', rest = ''] of text.matchAll(templated)) {
      reads.push(posix.join(base(anchor), rest));
    }
    for (const [, single, double] of text.matchAll(fromUrl)) {
      reads.push(posix.join(dirname(file), (single ?? double) as string));
    }
    for (const [, single, double] of text.matchAll(relative)) {
      const path = (single ?? double) as string;
      if (!path.startsWith('/')) reads.push(posix.normalize(path));
    }
  }
  return reads.filter((path) => path !== '.' && !path.startsWith('../'));
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
  it('holds no file and no directory any source under src/ reads from the checkout', () => {
    const reads = checkoutReads();
    const listed = listedFiles();
    // Neither side is vacuous: each anchor form the suite uses is seen, and the
    // list matches files this checkout holds.
    expect(reads).toEqual(
      expect.arrayContaining(['scripts/pre-commit', 'src', 'src/core/sandbox.utils.ts']),
    );
    expect(listed).toEqual(
      expect.arrayContaining([
        '.github/workflows/labeler.yml',
        'docs/adr/0139-the-gate-skips-the-test-stage-when-no-testable-file.md',
      ]),
    );
    const readListed = reads.flatMap((path) =>
      listed
        .filter((file) => file === path || file.startsWith(`${path}/`))
        .map((file) => ({
          path,
          file,
        })),
    );
    expect(readListed).toEqual([]);
  });
});
