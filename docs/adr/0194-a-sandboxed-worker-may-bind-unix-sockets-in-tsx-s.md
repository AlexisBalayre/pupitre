# 0194. A sandboxed worker may bind Unix sockets in tsx's socket directory, and nowhere else (2026-11-17)

- Status: accepted
- Amends: [0191](0191-a-worker-s-bash-calls-can-run-in-claude-code-s.md)

194. **A sandboxed worker may bind Unix sockets in tsx's socket directory, and nowhere else (2026-11-17).**
    *What failed.* On 2026-11-17 the pre-commit hook of a worker running under `workerSandbox: true`
    failed 2 tests in `src/core/test-slot.test.ts` with `listen EPERM` on
    `$TMPDIR/tsx-501/<pid>.pipe`. Those tests start the CLI through `node_modules/.bin/tsx`. On
    every run, tsx 4 opens an IPC server at `<os.tmpdir()>/tsx-<euid>/<pid>.pipe` (tsx 4.23.1, read
    from its bundle). Decision 191's block grants writes to Claude Code's temp dir. On macOS, though,
    binding a Unix socket is a network operation, and the block granted none. So a sandboxed worker
    could not run anything through tsx, and the setting could not be turned on for this project.
    *The grant.* Under the setting, the compiled `sandbox.network` also holds `allowUnixSockets`,
    with one entry: `/private/tmp/claude-<uid>/tsx-<euid>` (`tsxSocketDir`). Claude Code 2.1.326
    turns each entry into a `network-bind` and a `network-outbound` rule on `unix-socket (subpath …)`
    in its macOS profile, so the grant covers that directory and what is under it. Nothing else
    changes. `allowAllUnixSockets` stays unset, and the domain list, `strictAllowlist` and
    `allowLocalBinding` are as decision 191 left them. A test pins `sandbox.network` whole.
    `refuseUserSandbox` still refuses a user `sandbox` key, so the operator's settings cannot add a
    socket path.
    *The path.* Claude Code 2.1.326 sets a Bash child's `TMPDIR` to `claude-<uid>` under
    `CLAUDE_CODE_TMPDIR`, or under `/tmp` without the variable, and the sandbox matches the
    resolved path (`/tmp` is `/private/tmp` on macOS). A worker never has the variable: the launch
    strips every `CLAUDE*` variable from the tmux server's environment, and `--session-env` cannot
    name it (decision 106). So the compile does not read it. Claude Code also exports the variable
    into its own Bash children, so a compile run from one would otherwise read the conductor's
    temp dir. If a tmux server started outside pup hands a worker a different `CLAUDE_CODE_TMPDIR`,
    the grant names a directory tsx does not use. tsx then fails with `EPERM` as before, and
    nothing is widened.
    *The probe (2026-11-17).* Claude Code 2.1.326 on macOS: a `claude -p` run with permissions
    skipped, every `CLAUDE*` variable unset, `--setting-sources user` and a `--settings` file
    holding a `sandbox` block like the compiled one, granting the worktree. Without the grant,
    `tsx -e 1` failed with `listen EPERM: operation not permitted /tmp/claude-501/tsx-501/<pid>.pipe`.
    With it, `tsx -e` ran and printed `TMPDIR` as `/tmp/claude-501`. In both runs, a Node server on
    another socket in the same `TMPDIR` failed with `EPERM`, and `curl https://example.com` was
    refused as `host is not on the allow list`.
    *Ceilings.*
    1. The directory belongs to the user, not to the session. Every Claude Code session of that
       user puts its tsx sockets there: the conductor, unsandboxed workers and other sandboxed
       ones. A sandboxed worker can connect to any of them, and can bind a socket under another
       pid's name before that tsx starts. tsx removes the path before it listens. A client can send
       a tsx parent two messages: `signal`, which changes how the parent relays a signal to its
       child, and, in watch mode only, `dependency`, which adds a file to the watch list. Neither
       runs code the worker chooses (tsx 4.23.1, read from its bundle, not probed). A later tsx
       that handles more messages widens this ceiling.
    2. The grant follows Claude Code's choice of temp dir. Should a later version move it, tsx
       fails with `EPERM` again: the failure is closed, not a widening.
    3. Decision 191's ceiling 5 named a Unix socket in `TMPDIR` as one way to turn off
       `allowLocalBinding`. This grant does not open that way: it covers only tsx's own directory.
