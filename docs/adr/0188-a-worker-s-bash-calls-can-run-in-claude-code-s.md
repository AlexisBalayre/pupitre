# 0188. A worker's Bash calls can run in Claude Code's sandbox, behind a project setting (2026-11-16)

- Status: accepted
- Amends: [0005](0005-sessions-run-with-permissions-bypassed-compiled-hooks-are.md)
- Amends: [0063](0063-every-bash-call-is-re-checked-against-the.md)

188. **A worker's Bash calls can run in Claude Code's sandbox, behind a project setting (2026-11-16).**
    This is the first step of worker containment, decided on 2026-11-13. The per-worker container
    is a separate spike. Until now the compiled hooks were the only thing standing between a
    worker's shell and the machine (decision 5). Those hooks read the worktree after each call
    (decision 63), so they report a write after it has happened and cannot stop it.
    *The setting.* `workerSandbox: true` in the project's `.pupitre/project.yml` (decision 139's
    file, read from the main checkout) adds a `sandbox` block to every worker's compiled
    `settings.json`. It is read at compile time, so turning it on reaches the next launch and
    never a window already running. It is off by default. While it is off, the compiled settings
    are byte for byte what they were, and so is the profile hash. A value that is not a boolean
    refuses the compile, so a typo cannot launch a worker unsandboxed without anyone noticing. The
    conductor is not sandboxed.
    *What the block allows.*
    - Writes: the worktree, and the per-user temp directory Claude Code points `TMPDIR` at. Also
      the main `.git`, which Claude Code grants a linked worktree so that `git commit` can write
      objects and refs. Within that grant, its `config` and `hooks` and this worktree's
      `config.worktree` are denied. Of the store `~/.pupitre/<id>/`, the only writable files are
      `state.db` and its `-wal` and `-shm`, plus the machine's test slots in
      `~/.pupitre/slots/`. Every other path in the store is denied, the compiled hooks and the
      decision 63 snapshots included. The main checkout's working tree and the rest of the home
      directory are outside every grant.
    - Reads: everywhere except the operator's credentials: `~/.ssh`, `~/.gnupg`, `~/.aws`,
      `~/.config/gcloud`, `~/.config/gh`, `~/.kube`, `~/.docker`, `~/.netrc`,
      `~/.git-credentials`, `~/.npmrc`, `~/.pypirc` and `~/.claude/.credentials.json`.
    - Network: only the package registries of the ecosystems pup has adapters for:
      `registry.npmjs.org`, `registry.yarnpkg.com`, `pypi.org` and `files.pythonhosted.org`. A
      first commit's pre-commit install fetches from them. `strictAllowlist` refuses every other
      host. Without it, a session that skips permission prompts lets an unlisted host through.
      Binding to loopback stays allowed, for tests that start a local server.
    - `failIfUnavailable` refuses the launch when the sandbox cannot start. With
      `allowUnsandboxedCommands: false`, Claude Code ignores a call's `dangerouslyDisableSandbox`,
      so a worker cannot ask its way out.
    *Why `state.db` stays writable.* Every `pup` command a worker runs opens the store's database
    read-write: `pup session done`, `pup session ask`, and `pup session test`. The pre-commit hook
    runs `pup session test` inside the commit's sandbox. If the database were denied, a worker
    could neither commit nor finish. A worker can therefore still write rows in its project's
    database directly. That was already true without the sandbox, and decision 63's ceilings
    still cover it. What the sandbox does close is the store's files: a worker's shell can no
    longer rewrite its own compiled hooks, which run outside the sandbox, or its recheck
    snapshots. The registry tokens are kept from reads for the same reason as the other
    credentials: a registry is a host a worker can reach, and a token read there could publish to
    it.
    *What the sandbox does not cover.* It holds only the processes a Bash call starts. These stay
    outside it:
    - the Read, Edit and Write tools, which the scope hook and permission rules still guard;
    - the hooks, the status line and any MCP server;
    - the session's Claude Code process itself, with its model traffic.

    A subagent's Bash calls are sandboxed too. Anything the worker writes into the worktree still
    runs later outside the sandbox: through the merge gate, which has its own sandbox
    (decision 36), and through the operator's own commands. Containing those is the container
    spike's job.
    *Found when checking it.* pnpm cannot write the operator's shared store from the sandbox, so
    the pre-commit install falls back to a fresh store inside the worktree, `.pnpm-store/`. It
    then fetches every package into that store from the registry, which is why the registries
    are allowed. That store is about 6,000 untracked files. The count trips decision 63's cap of
    200 dirty paths, and once the cap trips, every later Bash call is refused. Opening the shared store would let a worker alter
    the package files other checkouts hard-link to. A pnpm project therefore lists `.pnpm-store/`
    in its `.gitignore` before it turns the setting on. Commit signing and git over SSH were not
    checked: neither runs in a worker today, and Claude Code documents that SSH remotes fail
    under its macOS sandbox.
