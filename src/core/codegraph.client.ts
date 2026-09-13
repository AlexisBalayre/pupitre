import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

/** Local by construction, and told so on every call (decision 51). */
const CODEGRAPH_ENV = { CODEGRAPH_TELEMETRY: '0' } as const;

/** Indexing this repo takes ~2.4s; a ceiling for a cold, large checkout. */
const INDEX_TIMEOUT_MS = 180_000;

/**
 * codegraph's own `.codegraph/.gitignore` (`*` plus `!.gitignore`) hides the
 * database but leaves the directory untracked — `?? .codegraph/` in porcelain,
 * which the gate and the overlap radar both read.
 */
const EXCLUDE_LINE = '.codegraph/';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT_SAFE_CONFIG, '-C', cwd, ...args], {
    encoding: 'utf8',
    env: scrubbedGitEnv(),
  }).trim();
}

/**
 * Absolute path of the `codegraph` binary, or undefined when the operator has
 * none. Resolved with `which`, like `claude` at launch: installed per node
 * version (nvm), the bare name would not survive being handed to a tmux server
 * that never read the operator's profile.
 */
export function codegraphBinary(): string | undefined {
  try {
    return execFileSync('which', ['codegraph'], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
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
      env: { ...process.env, ...CODEGRAPH_ENV },
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
        env: CODEGRAPH_ENV,
      },
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}
