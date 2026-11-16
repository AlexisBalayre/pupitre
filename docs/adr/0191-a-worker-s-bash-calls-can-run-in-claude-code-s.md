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
    conductor is not sandboxed. On Linux the setting refuses the compile for now (ceiling 12).
    *What the block allows.*
    - Writes allowed: the worktree, its admin dir under the main `.git`'s `worktrees/`, and the
      per-user temp directory Claude Code points `TMPDIR` at. Claude Code adds its own grant of
      the main `.git` for a session whose working directory is a linked worktree; its shape is
      under *The implicit `.git` grant* below. Of the store `~/.pupitre/<id>/`, only `state.db`
      and its `-wal` and `-shm` are allowed, and the session's own handoff document,
      `sessions/<id>/handoff.md`. `pup respawn` deletes that file and steers the worker to write
      it, the scope hook keeps the Write tool from it, and no pup command writes it, so without
      the grant a sandboxed worker could never be respawned with a handoff. The machine's test
      slots in `~/.pupitre/slots/` are allowed too.
    - Writes denied inside those grants. In the main `.git`, exactly these, none of which a
      worker's commit or merge writes:
      - the main checkout's own `config.worktree`. Git reads it once
        `extensions.worktreeConfig` is on, which `git sparse-checkout init` turns on, and a
        `core.fsmonitor` or `core.hooksPath` planted there would run in the operator's git;
      - `commondir`. A main checkout has none, but git reads `$GIT_DIR/commondir` for any git
        dir. One planted there, pointing at a decoy repo in the worktree, sends the operator's
        git in the main checkout to the decoy's `config` and its `core.fsmonitor`;
      - `modules/`, the git dirs of the main checkout's submodules. Each has its own `config` and
        `hooks/`, and the operator's `git status` runs a child git in every submodule. A linked
        worktree keeps its own submodules' git dirs in its admin dir, so a worker never writes
        here;
      - `info/`, `refs/replace/`, `refs/remotes/` and `shallow`;
      - `refs/heads/main` and its `.lock`;
      - `packed-refs` and its `.lock`, either of which would move `main` too;
      - the main checkout's own `HEAD`, `HEAD.lock`, `index`, `index.lock`, `MERGE_HEAD`,
        `ORIG_HEAD`, `FETCH_HEAD` and `CHERRY_PICK_HEAD`. A linked worktree keeps its own copies
        of these in its admin dir. A planted lock would stall every git command in the main
        checkout.
      - the main checkout's `rebase-merge/`, `rebase-apply/` and `sequencer/`. A todo planted
        there carries `exec` lines, which run on the operator's next `--continue`.

      The rest of the main `.git` stays writable to a sandboxed worker. That includes the
      following, and the list is not exhaustive:
      - objects, `logs/`, `rr-cache/`, `refs/tags/` and `refs/notes/`;
      - the branch refs other than `main`;
      - the main checkout's `REVERT_HEAD`, `REBASE_HEAD`, `BISECT_*`, `AUTO_MERGE`, `MERGE_MSG`
        and `SQUASH_MSG`.

      In this worktree's admin dir, `commondir`, `gitdir` and `config.worktree` are denied, since
      they say which repo and config git uses there.
    - Outside every grant, and so refused: the rest of the store (the compiled hooks and decision
      63's snapshots included), the main checkout's working tree and the rest of the home
      directory.
    - Reads: everywhere except the operator's credentials: `~/.ssh`, `~/.gnupg`, `~/.aws`,
      `~/.config/gcloud`, `~/.config/gh`, `~/.kube`, `~/.docker`, `~/.netrc`,
      `~/.git-credentials`, `~/.npmrc`, `~/.pypirc` and `~/.claude/.credentials.json`. A project
      whose windows run on another `CLAUDE_CONFIG_DIR` (decision 106) keeps the Claude
      credentials in that dir, and a worker's Bash inherits the variable, so its
      `.credentials.json` is denied as well. The config dir is resolved again at compile time,
      as the launch resolved it.
    *The Read tool.* The sandbox's read denial binds only Bash children, and the scope hook
    matches only Edit and Write. So the setting also adds two `Read(...)` rules per credential
    path to `permissions.deny`: the path itself and its `/**`, so a directory's files are
    covered. `~/` keeps its meaning in a rule and `//` roots an absolute path. Deny rules hold
    with permissions skipped (decision 5), and Claude Code applies Read rules to Grep and Glob
    too. With the setting off, no rule is added.
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
      commit. With it, they pass. Ceiling 5 below lists the ways to turn it off.
    - `failIfUnavailable` refuses the launch when the sandbox cannot start. With
      `allowUnsandboxedCommands: false`, Claude Code ignores a call's `dangerouslyDisableSandbox`,
      so a worker cannot ask its way out.
    *A deny wins.* In Claude Code's sandbox a `denyWrite` entry beats any `allowWrite` entry, even
    a narrower one. So the store is kept out of every grant rather than listed in `denyWrite`. A
    denied store root would take `state.db` with it. The first version of this decision did
    exactly that, so a sandboxed worker could not have run `pup session done`.
    *The implicit `.git` grant (probed 2026-11-16).* Claude Code's documentation says it grants a
    linked worktree "the main repository's shared `.git`" except `hooks/` and `config`. The first
    version of this decision read that as the whole `.git`. A probe pinned the real shape. It ran
    with an empty `sandbox.filesystem`, so only the implicit grant applied, and was started from
    the worktree.
    - Writable: objects; new and existing refs, `refs/heads/main` included; `logs/`; the main
      checkout's `HEAD`, `index` and `description`; `packed-refs`; new entries in `info/`,
      `refs/remotes/`, `refs/replace/` and at the `.git` root.
    - Writable in this worktree's admin dir: `index` and `HEAD`.
    - Refused: `config`, new entries in `hooks/`, this worktree's `commondir` and `gitdir`, two
      other worktrees' admin dirs, a new entry in `worktrees/`, and the worktree's own `.git`
      pointer file.

    So the grant is the main `.git` minus `config`, `hooks/` and every `worktrees/` entry but this
    worktree's own, and it does not reach the pointer file. `claude --debug` did not print the
    generated rules. It did log that the sandbox ignores "permission rules and sandbox.filesystem
    entries" from the disabled `projectSettings` and `localSettings` sources.
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
    - The registry tokens are kept from Bash reads and from the Read tool, but a worker can still
      `npm publish` with a token of its own, so the registries remain an exfiltration channel.
    - So does any token in the session's environment, such as `GH_TOKEN` or `NPM_TOKEN`. Bash
      children inherit it, and the sandbox only hides the variables `sandbox.credentials` lists,
      which this block lists none of.
    *What the sandbox does not cover.* It holds only the processes a Bash call starts. These stay
    outside it:
    - the Read, Edit and Write tools. The credential `Read(...)` rules above guard Read, Grep
      and Glob; the scope hook guards Edit and Write and nothing else;
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
    *Ceilings.* The setting is off by default and never looser than running without it. What it
    cannot close is stated here, not built around.
    1. The worktree's `.git` pointer file. The probe found Claude Code refuses it to Bash. The
       Edit and Write tools run outside the sandbox, though, and only the scope hook stands
       between them and the file. A rewritten pointer could send any unsandboxed git run in that
       worktree to a fake git dir that arms `core.fsmonitor` or `core.hooksPath`. That covers a
       hook, the gate, or the operator. A nested `.git` directory planted inside the worktree does
       the same: Bash can write it, since it is inside the worktree. Unsandboxed git run from that
       subdirectory then picks it up, the operator's own git included. pup's compiled hooks pin
       their git with `WorktreeGitEnv`, which pup computes from trusted paths (decision 101).
       Follow-up: every unsandboxed git call passes a trusted `--git-dir` and `--work-tree` plus
       hardened `-c` options.
    2. Other sessions' branches. `refs/heads/pup/*` stay writable, since a worker's own commit
       writes there and the deny cannot single out its own branch.
    3. `state.db`, `-wal` and `-shm` are an escape. A sandboxed worker can replace any of them
       with a symlink. Unsandboxed `pup`, the hooks and the gate then write through it, to wherever
       the link points. `~/.pupitre/slots/` is the same kind of redirect: a link planted there is
       followed by the unsandboxed gate's slot handling. Follow-up: open them with `lstat` and
       `O_NOFOLLOW`.
    4. Every deny is a literal path, matched path for path:
       - on case-insensitive APFS, a differently cased spelling may reach the same file. That
         applies to every denied entry (`rebase-merge/`, `sequencer/`, `HEAD.lock`,
         `index.lock` and the rest), not only `main`;
       - a reftable repository keeps no `refs/heads/main` file;
       - renaming a parent directory moves `main` with it.

       All three are ceilings. The deny also names `main` itself, so a project that merges into
       another branch is not covered.
    5. `allowLocalBinding` applies to the whole session, not only to the tests that need it.
       Alternatives:
       - tests that inject requests rather than open a socket;
       - a Unix socket in `TMPDIR`;
       - socket tests that run only in the gate.
    6. Objects. `objects/` must stay writable, since a commit writes there. A worker can
       therefore forge `objects/info/commit-graph`, or rewrite a loose object or a pack's `.idx`.
       Either changes the history the gate reads without touching a ref. Denying `refs/replace/`
       closes one way to swap objects, but it is not object integrity.
    7. A repository whose path runs through a symlink was not probed. Claude Code's implicit
       `.git` grant, and the paths pup compiles, may resolve differently there.
    8. `objects/info/alternates` stays writable. It can point git's object lookup at a
       directory of the worker's choosing.
    9. `rr-cache/` stays writable. A planted resolution is applied to a conflict whenever rerere
       is on.
    10. A main checkout whose `.git` is a file (a separate git dir) is not covered. Every deny
        then points at a path that does not exist.
    11. The denies on paths that do not exist yet, such as the locks and the rebase dirs, were
        probed only on macOS. Linux was not probed.
    12. The grants on paths that do not exist yet were probed only on macOS too, where a literal
        allow covers creating the file. `state.db-wal` and `-shm` usually do not exist at launch:
        SQLite deletes them when the last connection closes, which every short-lived `pup`
        command does. The handoff document does not exist either. Claude Code's Linux sandbox is
        expected to grant only the paths that exist when it starts, so on Linux a sandboxed
        `pup` may fail to open the store and the handoff may fail to write. Until Linux is
        probed, `workerSandbox: true` refuses the compile there, and so the launch, the way a
        malformed value does.
    *Left for follow-ups.*
    - Gaps in the read denials: `.yarnrc.yml`, `pip.conf`, cargo and gem credentials, the
      `.claude.json` in the home directory, and the transcripts.
    - A worktree-local settings file that loosens the sandbox. Claude Code ignores such a file's
      `sandbox.filesystem` entries and permission rules under `--setting-sources user`, as its
      debug log above says. Its other sandbox keys were not probed.
    - The test slots path, which every project on the machine shares.
