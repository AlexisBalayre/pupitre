import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { GIT_SAFE_CONFIG, scrubbedGitEnv } from './git-diff.client.js';

/**
 * CodeGraph (github.com/colbymchenry/codegraph) as a session capability: a local
 * SQLite graph of every symbol and edge in a checkout, served over MCP so a
 * session answers "how does X work", "how does X reach Y" and "what breaks if I
 * change Z" from the graph instead of a grep-and-read loop (decision 51).
 *
 * ONE GRAPH PER WORKTREE. Every function takes the directory it acts on and
 * none defaults to the repo root: codegraph resolves a project by walking
 * PARENTS for a `.codegraph/`, and a session's worktree sits at
 * `<repo>/.worktrees/<id>`, so an unindexed worktree resolves UP to the main
 * checkout and the session is served main's code under its own branch's name.
 * That is why the caller withholds the MCP config when this module throws.
 *
 * Absence of the binary is a capability, not an error: nothing here installs
 * anything, and a launch without a graph is a normal launch.
 */

/**
 * What indexing runs with, and nothing else. The binary is a third-party
 * `#!/usr/bin/env node` shim, so a full `process.env` would hand it every
 * secret in the operator's environment; `NODE_OPTIONS` alone is code execution
 * (`--require` runs inside the shim), and its cold path reads
 * `CODEGRAPH_DOWNLOAD_BASE` / `CODEGRAPH_INSTALL_DIR` to fetch and exec a
 * bundle. So the environment is built up from an allowlist rather than filtered
 * down, and the download path is refused outright: pup indexes with the binary
 * the operator installed or not at all.
 */
const INDEX_ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'USER'] as const;

function indexEnv(): NodeJS.ProcessEnv {
  const allowed: NodeJS.ProcessEnv = {};
  for (const name of INDEX_ENV_ALLOWLIST) {
    if (process.env[name] !== undefined) allowed[name] = process.env[name];
  }
  return { ...allowed, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_DOWNLOAD: '1' };
}

/**
 * What the served MCP server runs with. Claude Code spawns a stdio server as its
 * own child, so it inherits `CLAUDE_CODE_MESSAGING_SOCKET` and
 * `CLAUDE_CODE_MESSAGING_TOKEN` — the peer credentials that address other
 * sessions and the conductor, which decision 47 keeps off the tmux server for
 * exactly this reason. An `env` block overrides what is inherited, so they are
 * blanked here: a code indexer has no business holding them.
 *
 * Kept separate from `indexEnv` on purpose. That one is pup's own child and pup
 * chooses all of it; this one is a declaration handed to Claude Code, which
 * supplies the rest of the environment itself.
 */
const SERVED_ENV = {
  CODEGRAPH_TELEMETRY: '0',
  CLAUDE_CODE_MESSAGING_SOCKET: '',
  CLAUDE_CODE_MESSAGING_TOKEN: '',
} as const;

/** Indexing this repo takes ~2.4s; a ceiling for a cold, large checkout. */
const INDEX_TIMEOUT_MS = 180_000;

/**
 * codegraph's own `.codegraph/.gitignore` (`*` plus `!.gitignore`) hides the
 * database but leaves the directory untracked — `?? .codegraph/` in porcelain,
 * which the gate and the overlap radar both read.
 *
 * Anchored with a leading slash so it excludes the one directory codegraph
 * creates, at the root, and nothing else. Unanchored, `.codegraph/` matches at
 * every depth in every worktree forever, and a session that writes
 * `src/.codegraph/setup.ts` would be invisible to the worktree-clean stage —
 * uncommitted code the gate cannot see but a test run can read.
 */
const EXCLUDE_LINE = '/.codegraph/';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT_SAFE_CONFIG, '-C', cwd, ...args], {
    encoding: 'utf8',
    env: scrubbedGitEnv(),
  }).trim();
}

/**
 * Absolute path of the `codegraph` binary from OUTSIDE the repository, or
 * undefined when there is none. Resolved like `claude` at launch, because the
 * binary is installed per node version (nvm) and the bare name would not survive
 * being handed to a tmux server that never read the operator's profile.
 *
 * Both halves of that sentence are the security control. `which` echoes the PATH
 * entry it matched, and pnpm prepends the RELATIVE `./node_modules/.bin`, so
 * under `pnpm dev` the plain lookup answers `./node_modules/.bin/codegraph` — a
 * gitignored path inside the repo that a session can plant a script at, which
 * pup would then execute, and which `mcp.json` would record as a relative
 * command that every later session re-resolves against its own worktree. So:
 * `which -a`, and the first candidate that is both absolute and outside the
 * repository wins. A repo-local shim is not a fallback, it is the thing being
 * refused — an operator with only that has no codegraph.
 */
export function codegraphBinary(repoPath: string): string | undefined {
  const insideRepo = `${resolve(repoPath)}/`;
  let candidates: string;
  try {
    candidates = execFileSync('which', ['-a', 'codegraph'], { encoding: 'utf8' });
  } catch {
    return undefined;
  }
  return candidates
    .split('\n')
    .map((line) => line.trim())
    .find((path) => path !== '' && isAbsolute(path) && !path.startsWith(insideRepo));
}

/**
 * Add `.codegraph/` to the repository's shared `info/exclude`, once. Not a
 * tracked `.gitignore`: the exclusion is the operator's local tooling, not a fact
 * about the project, so pup would be committing to every contributor's repo on
 * its own account.
 *
 * `--git-path` resolves `info/exclude` to the COMMON dir even from a linked
 * worktree, so one line covers the main checkout and every worktree, including
 * ones that do not exist yet. Resolved against `cwd` because git answers
 * relative to where it was asked — `.git/info/exclude` from a main checkout,
 * absolute from a worktree — and appending to the relative one would write
 * wherever pup's process is standing.
 */
export function ensureCodegraphExcluded(cwd: string): void {
  const path = resolve(cwd, git(cwd, 'rev-parse', '--git-path', 'info/exclude'));
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (existing.split('\n').some((line) => line.trim() === EXCLUDE_LINE)) return;
  appendFileSync(path, `${existing && !existing.endsWith('\n') ? '\n' : ''}${EXCLUDE_LINE}\n`);
}

/**
 * Build or refresh one directory's graph, and throw if it cannot be built — the
 * caller decides what a missing graph costs. `init` creates `.codegraph/` and
 * indexes as it goes; `index` refuses to run before it ("CodeGraph not
 * initialized"). So a fresh worktree takes the init path, a reused one the index
 * path, and neither indexes twice.
 */
export function indexDirectory(binary: string, directory: string): void {
  const initialized = existsSync(join(directory, '.codegraph', 'codegraph.db'));
  execFileSync(
    binary,
    initialized ? ['index', directory, '--quiet'] : ['init', directory, '--yes'],
    {
      encoding: 'utf8',
      env: indexEnv(),
      timeout: INDEX_TIMEOUT_MS,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
}

/**
 * The `--mcp-config` contents: one stdio server pinned to this session's own
 * worktree. `--path` is explicit rather than left to the client's root, because
 * the resolution that runs when nothing pins it is the parent walk above.
 */
export function codegraphMcpConfig(binary: string, worktreePath: string): string {
  const config = {
    mcpServers: {
      codegraph: {
        type: 'stdio',
        command: binary,
        args: ['serve', '--mcp', '--path', worktreePath],
        env: SERVED_ENV,
      },
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}
