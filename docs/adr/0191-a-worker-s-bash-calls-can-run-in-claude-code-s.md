# 0191. A worker's Bash calls can run in Claude Code's sandbox, behind a project setting (2026-11-16)

- Status: accepted
- Amends: [0005](0005-sessions-run-with-permissions-bypassed-compiled-hooks-are.md)
- Amends: [0063](0063-every-bash-call-is-re-checked-against-the.md)

191. **A worker's Bash calls can run in Claude Code's sandbox, behind a project setting (2026-11-16).**
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
    - Writes allowed: the worktree, its admin dir under the main `.git`'s `worktrees/`, and the
      per-user temp directory Claude Code points `TMPDIR` at. The main `.git` itself is granted
      by Claude Code to any session whose working directory is a linked worktree, so that
      `git commit` can write objects and refs. Of the store `~/.pupitre/<id>/`, only `state.db`
      and its `-wal` and `-shm` are allowed, plus the machine's test slots in
      `~/.pupitre/slots/`.
    - Writes denied inside those grants: the main `.git`'s `config`, `hooks/` and `info/`;
      `refs/heads/main`; and `packed-refs`, through which `main` could be moved as well. In this
      worktree's admin dir, `commondir`, `gitdir` and `config.worktree` are denied, since they say
      which repo and config git uses there. The deny names `main` literally, which is the target
      branch on this repo. A project that merges into another branch is not covered.
    - Outside every grant, and so refused: the rest of the store (the compiled hooks and decision
      63's snapshots included), every other worktree's admin dir, the main checkout's working
      tree and the rest of the home directory.
    - Reads: everywhere except the operator's credentials: `~/.ssh`, `~/.gnupg`, `~/.aws`,
      `~/.config/gcloud`, `~/.config/gh`, `~/.kube`, `~/.docker`, `~/.netrc`,
      `~/.git-credentials`, `~/.npmrc`, `~/.pypirc` and `~/.claude/.credentials.json`.
    - Network: only the package registries of the ecosystems pup has adapters for:
      `registry.npmjs.org`, `registry.yarnpkg.com`, `pypi.org` and `files.pythonhosted.org`. A
      first commit's pre-commit install fetches from them. `strictAllowlist` refuses every other
      host. Without it, a session that skips permission prompts lets an unlisted host through.
      Claude Code honours that key only from user, managed or `--settings` settings, never from
      a project settings file. A worker's compiled settings reach it as
      `claude --settings <store>/sessions/<id>/compiled/settings.json --setting-sources user`
      (`launchArgs`), so the worktree's own `.claude/` settings are not loaded and the key holds.
      `allowLocalBinding` stays on, at a cost. On macOS it also lets sandboxed commands connect
      to every localhost port, which includes pup's own web dashboard, browser debug ports and
      local databases. It stays on because `src/core/web-dashboard.test.ts` listens on loopback,
      and the pre-commit hook runs that test inside the sandbox for any staged file it imports.
      Without local binding, all 81 of its tests fail with `listen EPERM` and the worker cannot
      commit. With it, they pass. Turning it off means first moving those tests off a real
      socket, or out of the sandboxed commit.
    - `failIfUnavailable` refuses the launch when the sandbox cannot start. With
      `allowUnsandboxedCommands: false`, Claude Code ignores a call's `dangerouslyDisableSandbox`,
      so a worker cannot ask its way out.
    *A deny wins.* In Claude Code's sandbox a `denyWrite` entry beats any `allowWrite` entry, even
    a narrower one. So the store and the other worktrees' admin dirs are kept out of every grant
    rather than listed in `denyWrite`. A denied store root would take `state.db` with it. The
    first version of this decision did exactly that, so a sandboxed worker could not have run
    `pup session done`.
    *The live probe (2026-11-16).* Claude Code 2.1.325 on macOS, with the block compiled for this
    session, delivered by `--settings` and started from the worktree. It refused:
    - `curl https://example.com`, reported as
      `deny network-outbound example.com:443 (host is not on the allow list)`;
    - with `allowLocalBinding` off: a connection to a server on `127.0.0.1`, and binding a
      loopback port (with it on, both succeed);
    - writes to `.git/config`, `info/`, `refs/heads/main`, `packed-refs`, this worktree's
      `commondir`, `gitdir` and `config.worktree`, two other worktrees' admin dirs, a new entry in
      `worktrees/`, a new store file and the compiled `bash-recheck.sh`.

    It allowed `curl https://registry.npmjs.org`, git object and branch-ref writes, the worktree's
    `index` and `state.db`.
    *Why `state.db` stays writable.* Every `pup` command a worker runs opens the store's database
    read-write: `pup session done`, `pup session ask`, and `pup session test`. The pre-commit hook
    runs `pup session test` inside the commit's sandbox. If the database were denied, a worker
    could neither commit nor finish. A worker can therefore still write rows in its project's
    database directly. That was already true without the sandbox, and decision 63's ceilings
    still cover it. What the sandbox does close is the store's files: a worker's shell can no
    longer rewrite its own compiled hooks, which run outside the sandbox, or its recheck
    snapshots.
    *Exfiltration it does not stop.* Every reachable host is a way out:
    - The registry tokens are kept from reads, but a worker can still `npm publish` with a token
      of its own, so the registries remain an exfiltration channel.
    - So does any token in the session's environment, such as `GH_TOKEN` or `NPM_TOKEN`. Bash
      children inherit it, and the sandbox only hides the variables `sandbox.credentials` lists,
      which this block lists none of.
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
    200 dirty paths, and once the cap trips, every later Bash call is refused. Opening the shared
    store would let a worker alter the package files other checkouts hard-link to. A pnpm project
    therefore lists `.pnpm-store/` in its `.gitignore` before it turns the setting on. Commit
    signing and git over SSH were not checked: neither runs in a worker today, and Claude Code
    documents that SSH remotes fail under its macOS sandbox.
    *Left for follow-ups.*
    - Swapping `state.db` for a symlink. Opening it should refuse a link (`lstat`, `O_NOFOLLOW`).
    - Gaps in the read denials: `.yarnrc.yml`, `pip.conf`, cargo and gem credentials, the
      `.claude.json` in the home directory, and the transcripts.
    - A worktree-local settings file that loosens the sandbox.
    - The test slots path, which every project on the machine shares.
