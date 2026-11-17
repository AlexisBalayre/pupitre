# 0196. A sandboxed worker may bind Unix sockets in tsx's socket directory, and nowhere else (2026-11-17)

- Status: accepted
- Amends: [0191](0191-a-worker-s-bash-calls-can-run-in-claude-code-s.md)

196. **A sandboxed worker may bind Unix sockets in tsx's socket directory, and nowhere else (2026-11-17).**
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
    the grant names a directory the worker's tsx does not use, and that tsx fails with `EPERM` as
    before. The grant is not a no-op there: it still lets the worker reach the sockets that the
    user's other sessions put in the default directory (ceiling 1). Without a uid to name the
    directory, the compile refuses rather than guess root's.
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
       The directory's entries are writable under Claude Code's own temp grant, so a worker can
       also delete the socket of a running tsx parent, unsandboxed ones included, and bind its own
       under that name. The parent's child then reports to the worker: the signals it caught and,
       in watch mode, the path of every file it loads. The parent hears nothing more from it, so
       its signal relay and its watch list stop working.
    2. Neither a symlink nor a hard link carries the grant out (probed 2026-11-17, Claude Code
       2.1.326, macOS, uid 501).
       *Method.* Every `CLAUDE*` variable unset, from a temp git worktree:
       `claude --model claude-haiku-5-5 --dangerously-skip-permissions --settings <file>
       --setting-sources user -p "Run this exact command with the Bash tool, once, then reply
       with its raw output only: node <client.js> …"`. These are `launchArgs`' flags, without the
       name and effort. The listeners were `nc -lkU <path>`, started from the operator's shell and
       so unsandboxed. The outside one was on `s.sock` in a fresh
       `mktemp -d /private/tmp/pup-sockprobe-XXXX`, outside `claude-501`. No tmux, ssh-agent,
       docker, gpg or Claude socket was used. The sandboxed client was Node: connect is
       `net.connect(path)`, bind is `net.createServer().listen(path)`, the hard link is
       `execFileSync('ln', [outside socket, x])`, and the symlinks are `fs.symlinkSync`. Errors
       are quoted as Node or `ln` printed them, with `<o>` for the outside directory and `<t>`
       for the run's tag.
       *Run 1, pup's own compiled `settings.json`:* `compileProfile` and `writeCompiledProfile`
       for a temp repo whose `.pupitre/project.yml` holds `workerSandbox: true`. That is the
       worker's hooks and sandbox block, which grants `/private/tmp/claude-501/tsx-501` only. The
       entries were made in that real directory under `pup-probe-*-<t>` names, and removed after.
       - Positive control: connect to an unsandboxed `nc -lkU` on `tsx-501/pup-probe-pos-<t>.sock`
         was `OK`, and nc printed what the client sent. A bind in `tsx-501` was `OK`.
       - Direct, outside: `connect EPERM <o>/s.sock`, and
         `listen EPERM: operation not permitted <o>/direct.sock`.
       - (b) Creating `tsx-501/pup-probe-sx-<t>` as a symlink to `<o>/s.sock` was `OK`. Connect
         through it: `connect EPERM /private/tmp/claude-501/tsx-501/pup-probe-sx-<t>`.
       - (c) Creating `tsx-501/pup-probe-sy-<t>` as a dangling symlink to `<o>/new-b.sock` was
         `OK`. Bind through it:
         `listen EPERM: operation not permitted /private/tmp/claude-501/tsx-501/pup-probe-sy-<t>`.
       - (d) `ln <o>/s.sock /private/tmp/claude-501/tsx-501/pup-probe-x-<t>` was denied:
         `ln: /private/tmp/claude-501/tsx-501/pup-probe-x-<t>: Operation not permitted`, and no
         link was made. Connect through that path then gave
         `connect ENOENT /private/tmp/claude-501/tsx-501/pup-probe-x-<t>`.
       - (d2) A hard link `tsx-501/pup-probe-h-<t>` to `<o>/s.sock`, made unsandboxed before
         launch (same inode, link count 2). Connect through it was also denied:
         `connect EPERM /private/tmp/claude-501/tsx-501/pup-probe-h-<t>`.
       *Run 2, a hand-written block.* It holds the compiled `network` keys, with `allowWrite`
       set to the worktree. Its `allowUnixSockets` names three entries in `/private/tmp/claude-501`,
       since a granted entry that is itself a link cannot be staged on the real `tsx-501`, which
       other sessions use:
       - `pup-probe-a1-<t>`, a symlink to `<o>` planted before launch;
       - `pup-probe-a2-<t>`, a real directory;
       - `pup-probe-b-<t>`, a real directory.
       - Positive control: connect to an unsandboxed `nc -lkU` on `pup-probe-b-<t>/pos.sock` was
         `OK`, and nc printed what the client sent.
       - Direct, outside: the same two `EPERM` lines as run 1.
       - (a) Connect: `connect EPERM /private/tmp/claude-501/pup-probe-a1-<t>/s.sock`.
         (c) Bind: `listen EPERM: operation not permitted /private/tmp/claude-501/pup-probe-a1-<t>/new-a.sock`.
       - (a') The sandboxed client removed `pup-probe-a2-<t>` and made it a symlink to `<o>`.
         Both steps were `OK`. Connect: `connect EPERM /private/tmp/claude-501/pup-probe-a2-<t>/s.sock`.
         (c) Bind: `listen EPERM: operation not permitted /private/tmp/claude-501/pup-probe-a2-<t>/new-a2.sock`.
       In both runs, the outside `nc` printed nothing, and `<o>` held only `s.sock` afterwards. An
       earlier pair of runs with an unsandboxed Node listener, which recorded only error codes,
       matched. The probes show the following:
       - Claude Code does not turn a link in a granted entry into a grant on the link's target.
       - The sandbox refuses a socket reached through a granted name, by symlink or by hard link,
         when its other name lies outside the grant.
       - The sandbox refuses to make a hard link into `tsx-501` at all.
       Only macOS was probed, and the setting compiles on no other platform.
    3. The grant follows Claude Code's choice of temp dir. Should a later version move it, tsx
       fails with `EPERM` again, while the grant keeps reaching the old directory's sockets.
    4. Decision 191's ceiling 5 named a Unix socket in `TMPDIR` as one way to turn off
       `allowLocalBinding`. This grant does not open that way: it covers only tsx's own directory.
