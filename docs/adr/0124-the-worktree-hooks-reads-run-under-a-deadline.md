# 0124. The worktree hooks' reads run under a deadline, and the served code graph's git runs pinned (2026-10-29)

- Status: accepted
- Amends: [0063](0063-every-bash-call-is-re-checked-against-the.md), [0099](0099-workers-share-files-and-collaborate-a-launch-overlapping.md), [0101](0101-git-in-a-session-worktree-runs-pinned-to.md)

124. **The worktree hooks' reads run under a deadline, and the served code graph's git runs pinned (2026-10-29).**
    Amends decisions 63, 99 and 101. The scope hook, the Bash re-check and the read guard run
    outside the sandbox under Claude Code's 5-second hook timeout, which fails open. Some of
    their reads open files the session can write, and opening a fifo blocks until a writer
    comes, which none does. Three ceilings recorded this: decision 99's MERGE_HEAD read, which
    a fifo swapped in after its `-f` test blocks; decision 101's `head` of the gitfile and the
    `commondir` after the same test; and decision 63's read of a dirty file swapped for a fifo
    after its regular-file test. A fourth was not recorded. git opens every file an
    `include.path` or a matching `includeIf` names in the shared `<common>/config`, before it runs
    any command, and that config is the session's to write (decision 41's exposure). A fifo
    named there blocked every `safe_git` call, so the hooks failed open on every tool call
    while it stayed (reproduced on Apple Git 2.39.5: `status`, `rev-parse` and `ls-files`
    block, while `config --file` reads no include).
    *One deadline per hook.* The shared shell (`worktreeGitShell`) records a deadline when the
    hook starts, `HOOK_READ_DEADLINE_SECONDS` (the hook timeout less one) of `date +%s`.
    `bounded` runs a command in the background, with a watcher that `kill -9`s it once the
    deadline passes. A killed command, or one asked for after the deadline, fails with a
    `BLOCKED: a read in <worktree> outran the hook deadline` line. Every `safe_git` call goes
    through it, as `bounded env GIT_DIR=… git …`, and so does every read of a file the session can
    write: the two pointer `head`s, MERGE_HEAD's `head`, and the re-check's `wc` of a dirty
    file. The command is exec'd in place, never a shell function, so the kill reaches the
    process that blocks, and a command substitution around it sees its output close. The
    deadline belongs to the hook, not to each call. A check of many paths therefore cannot
    spend it once per path, and after one blocked read every later one fails at once. Whole
    seconds put the kill between 3 and 4 seconds after the start, which leaves the hook a
    second to refuse. Each refuses the way it refuses a git failure. The scope hook
    refuses the conflict-resolution Edit. The re-check fails its snapshot before the call and
    refuses after it ("could not read git status"). A dirty file whose read was killed is
    fingerprinted `unreadable`, which makes it a new violation. The read guard fails open, as it
    does for any pointer it cannot check. Bash prints a job a signal ended to the shell's
    stderr, so both `wait`s drop theirs, and the watcher writes to `/dev/null` so no `sleep` it
    leaves behind holds the hook's pipes. *Cost.* About 5 ms a call for the `date`, the `env`
    exec and the watcher's `sleep`: the re-check over a clean worktree took a median 239 ms
    against 207 ms unbounded, under a load average near 100. Not taken: perl's `alarm`,
    a new runtime dependency for the hooks; a watchdog over the whole hook, which has no
    process group of its own to kill and whose shell defers a trap until its blocked child
    returns; GNU `timeout`, which macOS lacks.
    *The served code graph's git runs pinned.* Decision 101 left the server Claude Code spawns
    from `mcp.json` with the git config but not the pins, since `codegraphMcpConfig` has no repo
    path. Its `git status` runs outside the sandbox for the window's whole life. For the
    conductor, whose server runs `--path <checkout>` for as long as the conductor does, a
    session that rewrote `<common>/worktrees/checkout/commondir` and that admin dir's `index`
    toward a repo with an armed `filter.<x>.clean` got the filter run outside the sandbox. The
    profile compiler has both paths, so `servedGraphConfig` adds `worktreeGitEnv(repoPath,
    <served dir>)` to the server's env, for a session's worktree and the conductor's checkout
    alike, with `GIT_CONFIG_NOSYSTEM=1`. Those are the dirs the launch's
    `verifiedWorktreeGitEnv`, or the conductor's `refreshConductorCheckout`, checks before
    `mcp.json` is handed over: a check that fails withholds the file (decision 51). The system
    config is a file pup never checks, and a Homebrew git keeps it in a prefix the operator
    owns. The server's other env is unchanged: `GIT_SAFE_CONFIG` and the submodule pair as
    command-scope config, telemetry off, the messaging credentials blanked. The compiler adds
    the pins to the config `codegraphMcpConfig` returns, whose doc comment on `SERVED_ENV` in
    `codegraph.client.ts` still says the pins are not there, for want of a path.
    *Ceilings.* The store files the hooks read (`scope-in.pat`, `scope-out.pat`, the
    snapshots) are not bounded. They sit where a session's shell can reach (decision 57), and
    a session that can rewrite them can rewrite the hooks themselves. A gitlink planted with a
    `.gitmodules` override still makes the served server's `status` run a child git in the
    submodule, which drops the pins, as it does for any git Claude Code runs after its
    startup (decision 101's submodule ceiling). The deadline bounds the time the hook takes,
    not what a killed git had already done. A `sleep` per bounded call outlives the call, up
    to the deadline, holding nothing.
    *Tests* (`profile-compiler.test.ts`). A `head` on the scope hook's PATH turns MERGE_HEAD into
    a fifo after the `-f` test and then reads it. The resolving Edit, which passes before the
    swap, is refused in under 5 seconds with the deadline line. An `include.path` in the repo
    config naming a fifo has the resolving Edit refused, and the re-check after a call refuse
    with the deadline line and "could not read git status", each in under 5 seconds. A `wc`
    on the re-check's PATH turns a dirty out-of-scope file into a fifo after the
    regular-file test. The check is refused in under 5 seconds and records the violation.
    Each test runs its hook under a 15-second timeout, so without the deadline it fails slow
    or with a null status, never with the test's own kill read as a refusal. A session's
    `mcp.json` carries the three pins, `GIT_CONFIG_NOSYSTEM=1` and the command-scope config.
    The conductor's, compiled over a real repo and checkout, carries exactly the dirs
    `verifiedWorktreeGitEnv` returns for that checkout.
