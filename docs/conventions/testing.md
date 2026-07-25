# Testing Conventions

Rules for test files in `src/`. Auto-loaded via `.claude/rules/testing-conventions.md` when you
touch a test. The runner is **Vitest**; `pnpm test` runs everything.

Tests sit next to the file they cover and are named for it — see the "Test files" section of
[naming.md](naming.md) for how the filename is derived.

## Prefer the real dependency over a mock

Pupitre's dependencies are a SQLite file, a git repo, and a handful of CLIs. All three are cheap
to stand up for real in a temp directory, and a real one catches what a mock cannot — a
malformed migration, a git invocation that works on a fresh repo but not a rebased one.

So: **build a real store and a real repo per test.** `openStore(':memory:')` gives a fully
migrated SQLite database with no file to clean up; a temp directory driven by `execFileSync`
gives a real git repo.

```ts
const db = openStore(':memory:');
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'pup-test-')));
```

Pass a real path to `openStore` only when the test is about the file itself (permissions,
migration on an existing database). `realpathSync` matters on macOS, where `tmpdir()` is a
symlink and path comparisons against git's output would otherwise fail.

## Keep the environment hermetic

A test that shells out to git must not inherit the developer's git config or `GIT_*`
variables — these suites also run inside the repo's own pre-commit hook, where an inherited
`GIT_DIR` silently redirects every call at the pupitre repo instead of the temp one.

```ts
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
```

## Faking an external CLI

For a CLI that would reach the network (`gh`), don't mock the module that spawns it — write a
shell script into a temp `bin/`, put that directory first on the child's `PATH`, and have the
script log its argv. The test then asserts on **what pup asked the CLI to do**, which is the
contract that actually matters, and the spawn path stays under test.

```sh
#!/bin/sh
printf '%s\n' "$*" >> "$ghLog"
[ "$1" = "--version" ] && exit 0
```

## When `vi.mock` is right

Reserve it for modules whose real behaviour is out of scope for a test process — spawning a
tmux pane or a `claude -p` session. That is the whole current list.

**Mock ordering matters.** `vi.mock` is hoisted, but factory references and spies are not:
declare and configure mocks **before** importing the unit under test, or the unit captures the
real implementation at import time.

```ts
// Without this, every merging test would spawn a real `claude -p` call.
vi.mock('../claude/session-runtime.service.js', () => ({
  killSession: vi.fn(),
  steerSession: vi.fn(),
}));

// import AFTER the mock is declared
import { runMergeGate } from './merge-gate.service.js';
```

## Structure

- **Arrange / Act / Assert.** Keep the three phases visually distinct.
- **Test behaviour and public contracts, not implementation details.** Assert on what a caller
  observes — a return value, a thrown typed error, a row that landed in the store. Tests
  coupled to internals break on every refactor.
- **One logical assertion focus per test.** A test verifies a single behaviour; multiple
  `expect`s are fine when they describe one outcome.
- **Name the test after the behaviour, not the function.** `it('pairs sessions whose diffs
  share a file, files sorted')` tells a reader what breaks when it goes red.

```ts
describe('intersectSessionFiles', () => {
  it('pairs sessions whose diffs share a file, files sorted', () => {
    const pairs = intersectSessionFiles({
      s1: ['src/a.ts', 'src/b.ts'],
      s2: ['src/b.ts', 'src/a.ts', 'src/c.ts'],
      s3: ['src/z.ts'],
    });

    expect(pairs).toEqual([{ sessionA: 's1', sessionB: 's2', files: ['src/a.ts', 'src/b.ts'] }]);
  });
});
```

Pure functions like this one need no fixture at all — reach for the temp store and repo only
when the behaviour under test genuinely involves them.

## Cross-links

- The **`tdd`** skill drives the red-green-refactor loop — write the failing test first, make
  it pass, then refactor.
- The `testing-conventions` rule auto-loads this doc whenever you open a test file, so the
  conventions are in context while you write.
