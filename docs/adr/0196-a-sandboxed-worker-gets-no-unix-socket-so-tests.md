# 0196. A sandboxed worker gets no Unix socket, so tests start tsx through `node --import` (2026-11-17)

- Status: accepted
- Amends: [0191](0191-a-worker-s-bash-calls-can-run-in-claude-code-s.md)

196. **A sandboxed worker gets no Unix socket, so tests start tsx through `node --import` (2026-11-17).**
    *What failed.* On 2026-11-17 the pre-commit hook of a worker running under `workerSandbox: true`
    failed 2 tests in `src/core/test-slot.test.ts` with `listen EPERM` on
    `$TMPDIR/tsx-501/<pid>.pipe`. Those tests started the CLI through `node_modules/.bin/tsx`. On
    every run, tsx 4's CLI opens an IPC server at `<os.tmpdir()>/tsx-<euid>/<pid>.pipe` (tsx 4.23.1,
    read from its bundle). Decision 191's block grants writes to Claude Code's temp dir. On macOS,
    though, binding a Unix socket is a network operation, and the block grants none.
    *The decision.* The compiled `sandbox.network` stays as decision 191 left it: no
    `allowUnixSockets`, and `allowAllUnixSockets` unset. A test pins `sandbox.network` whole. The
    two tests start the CLI with `node --import tsx <cli>` instead. Under `--import`, tsx's loader
    binds nothing. It only connects to its parent's pipe, `tsx-<euid>/<ppid>.pipe`, to report to a
    tsx CLI that may have started it, and it ignores a failed connect (tsx 4.23.1, read from its
    bundle). So the tests need no socket. A worker that runs tsx's own CLI under the setting still
    fails with `EPERM`. `pup` itself runs from the compiled `dist/cli/index.js`, not through tsx.
    *Why not grant tsx's directory.* A first version granted `/private/tmp/claude-<uid>/tsx-<euid>`
    in `allowUnixSockets`. Claude Code 2.1.326 turns each entry into a `network-bind` and a
    `network-outbound` rule on `unix-socket (subpath …)` in its macOS profile. The sandbox can
    write the whole of `/private/tmp/claude-<uid>`, Claude Code's temp dir, where every session of
    the user puts its temp files and sockets, unsandboxed ones included. A probe (run 3 below)
    showed that a sandboxed `mv` carries such a socket, or its directory, into the granted
    directory, and a connect then reaches the unsandboxed listener. So the grant opened every
    socket the user's other sessions put in that temp dir, not only tsx's.
    *The probes (2026-11-17, Claude Code 2.1.326, macOS, uid 501).*
    *Method.* Every `CLAUDE*` variable unset, from a temp git worktree:
    `claude --model claude-haiku-5-5 --dangerously-skip-permissions --settings <file>
    --setting-sources user -p "Run this exact command with the Bash tool, once, then reply with its
    raw output only: node <client.js> …"`. These are `launchArgs`' flags, without the name and
    effort. The listeners were `nc -lkU <path>`, started from the operator's shell and so
    unsandboxed. No tmux, ssh-agent, docker, gpg or Claude socket was used. The sandboxed client
    was Node: connect is `net.connect(path)`, bind is `net.createServer().listen(path)`, a move is
    `execFileSync('mv', [from, to])`, a hard link is `execFileSync('ln', [from, to])`, and the
    symlinks are `fs.symlinkSync`. Errors are quoted as Node, `mv` or `ln` printed them, with `<o>`
    for an outside directory made by `mktemp -d /private/tmp/pup-sockprobe-XXXX` (outside
    `claude-501`), `<o>/s.sock` its listener, and `<t>` for the run's tag. Every `pup-probe-*`
    entry was removed after each run.
    *Run 0, no grant.* A `sandbox` block like the compiled one, granting the worktree:
    `tsx -e 1` failed with `listen EPERM: operation not permitted /tmp/claude-501/tsx-501/<pid>.pipe`.
    *Run 1, pup's compiled `settings.json` with the grant:* `compileProfile` and
    `writeCompiledProfile` for a temp repo whose `.pupitre/project.yml` holds `workerSandbox: true`,
    when the block granted `/private/tmp/claude-501/tsx-501`. Entries were made in that real
    directory under `pup-probe-*-<t>` names.
    - Positive control: connect to an unsandboxed `nc -lkU` on `tsx-501/pup-probe-pos-<t>.sock` was
      `OK`, and nc printed what the client sent. A bind in `tsx-501` was `OK`.
    - Direct, outside: `connect EPERM <o>/s.sock`, and
      `listen EPERM: operation not permitted <o>/direct.sock`.
    - (b) Creating `tsx-501/pup-probe-sx-<t>` as a symlink to `<o>/s.sock` was `OK`. Connect through
      it: `connect EPERM /private/tmp/claude-501/tsx-501/pup-probe-sx-<t>`.
    - (c) Creating `tsx-501/pup-probe-sy-<t>` as a dangling symlink to `<o>/new-b.sock` was `OK`.
      Bind through it:
      `listen EPERM: operation not permitted /private/tmp/claude-501/tsx-501/pup-probe-sy-<t>`.
    - (d) `ln <o>/s.sock /private/tmp/claude-501/tsx-501/pup-probe-x-<t>` was denied:
      `ln: /private/tmp/claude-501/tsx-501/pup-probe-x-<t>: Operation not permitted`. Connect
      through that path then gave `connect ENOENT /private/tmp/claude-501/tsx-501/pup-probe-x-<t>`.
    - (d2) A hard link `tsx-501/pup-probe-h-<t>` to `<o>/s.sock`, made unsandboxed before launch
      (same inode, link count 2). Connect through it:
      `connect EPERM /private/tmp/claude-501/tsx-501/pup-probe-h-<t>`.
    *Run 2, a hand-written block.* It holds the compiled `network` keys, with `allowWrite` set to
    the worktree. Its `allowUnixSockets` names three entries in `/private/tmp/claude-501`, since a
    granted entry that is itself a link cannot be staged on the real `tsx-501`, which other
    sessions use: `pup-probe-a1-<t>`, a symlink to `<o>` planted before launch, and
    `pup-probe-a2-<t>` and `pup-probe-b-<t>`, real directories.
    - Positive control: connect to an unsandboxed `nc -lkU` on `pup-probe-b-<t>/pos.sock` was `OK`,
      and nc printed what the client sent. A bind in `pup-probe-b-<t>` was `OK`, and the socket
      existed after.
    - Direct, outside: the same two `EPERM` lines as run 1.
    - (a) Connect: `connect EPERM /private/tmp/claude-501/pup-probe-a1-<t>/s.sock`. Bind:
      `listen EPERM: operation not permitted /private/tmp/claude-501/pup-probe-a1-<t>/new-a.sock`.
    - (a') The sandboxed client removed `pup-probe-a2-<t>` and made it a symlink to `<o>`. Both
      steps were `OK`. Connect: `connect EPERM /private/tmp/claude-501/pup-probe-a2-<t>/s.sock`.
      Bind: `listen EPERM: operation not permitted /private/tmp/claude-501/pup-probe-a2-<t>/new-a2.sock`.
    In runs 1 and 2, the outside `nc` printed nothing, and `<o>` held only `s.sock` afterwards.
    *Run 3, rename, with run 1's compiled settings.* Each source was a fresh directory
    `/private/tmp/claude-501/pup-probe-src-<n>-<t>`, holding `s.sock` with its own unsandboxed
    `nc -lkU`, and the same positive control as run 1, which printed what the client sent.
    - Direct: `connect EPERM /private/tmp/claude-501/pup-probe-src-iii-<t>/s.sock`.
    - (i) `mv /private/tmp/claude-501/pup-probe-src-i-<t>/s.sock
      /private/tmp/claude-501/tsx-501/pup-probe-mv-<t>.sock` was `OK`. Connect to the new path was
      `OK`, and the src-i listener printed what the client sent.
    - (ii) `mv /private/tmp/claude-501/pup-probe-src-ii-<t>
      /private/tmp/claude-501/tsx-501/pup-probe-mvdir-<t>` was `OK`. Connect to
      `…/pup-probe-mvdir-<t>/s.sock` was `OK`, and the src-ii listener printed what the client sent.
    - (iii) `ln /private/tmp/claude-501/pup-probe-src-iii-<t>/s.sock
      /private/tmp/claude-501/tsx-501/pup-probe-ln-<t>` was denied:
      `ln: /private/tmp/claude-501/tsx-501/pup-probe-ln-<t>: Operation not permitted`. Connect then
      gave `connect ENOENT /private/tmp/claude-501/tsx-501/pup-probe-ln-<t>`.
    So links never carry a grant out, but a rename into a granted directory does, and the sandbox
    may rename anything under its writable temp dir.
    *Run 4, the change.* Pup's compiled `settings.json` without the grant, from this worktree:
    `node --import tsx src/cli/index.ts --help` printed pup's usage, and
    `node_modules/.bin/tsx src/cli/index.ts --help` failed with
    `EPERM: operation not permitted /tmp/claude-501/tsx-501/<pid>.pipe`.
    *Ceilings.*
    1. Any test or script that runs tsx's CLI, `tsx watch` included, fails under the setting with
       `EPERM`. It must start through `node --import tsx` instead.
    2. A later tsx whose loader binds a socket, or fails when its connect does, breaks the two
       tests again.
    3. Decision 191's ceiling 5, a Unix socket in `TMPDIR` as one way to turn off
       `allowLocalBinding`, stays closed: no socket path is granted.
    4. Only macOS was probed, and the setting compiles on no other platform.
