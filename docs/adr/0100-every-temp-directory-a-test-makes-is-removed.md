# 0100. Every temp directory a test makes is removed when the test finishes, and the gate's sandbox run ends with the gate, after killing what still writes in it (2026-10-18)

- Status: accepted

100. **Every temp directory a test makes is removed when the test finishes, and the gate's
    sandbox run ends with the gate, after killing what still writes in it (2026-10-18).**
    On 2026-10-18 the temp folder held 327,602 `pup-*` entries: 78k `pup-cli-` from
    `index.test.ts`, 33k `pup-gate-`, 31k `pup-ghlog-`, 14k `pup-dashboard-home-` and so on down
    the 33 test files that called `mkdtempSync`, most of which removed nothing. macOS XProtect and
    endpoint security scanned them, the load average reached 30, and a gate's test stage failed
    on it. One full suite run in a private `TMPDIR` left 1,885 entries.
    *Tests.* `tempDir(prefix)` in `src/test/temp-dir.mock.ts` is the one way a test makes a temp
    directory: `mkdtemp` under `os.tmpdir()`, resolved, and removed by `onTestFinished`, so on a
    pass and a failure alike, with three retries. It works from a test and from a `beforeEach`,
    where vitest knows the running test, and throws elsewhere. It also removes the toolchain cache
    a gate child keyed on that directory (`pup-toolchain-cache/<projectId>`): built to outlive a
    run, not a repo, and 250 of them piled up per suite run once the directories themselves went.
    Each file's pass-through helper and its own `rmSync` cleanup went with the change; an `rmSync`
    a test exercises, such as removing a directory to test the "gone" case, stayed.
    `sandbox-utils.test.ts`'s checkout under `HOME` keeps a cleanup of its own that removes its
    cache the same way.
    *The gate's scratch.* A sandbox run (the stage children's `TMPDIR` and their profiles) was
    process-scoped and removed on `exit`. A vitest worker never emits `exit`, which left one
    `pup-gate-` and one `pup-sandbox-` per test file per run, and a process that outlives a gate
    kept one. `endSandboxRun` now ends it. The gate calls it under the lock on every way out
    (merge, refusal, throw), before dropping its checkout. `pup init` and `pup audit`, one command
    to a process, keep the `exit` listener, which calls the same function. Test files that run
    gate children outside a gate call it in `afterAll`, and `sandbox-utils.test.ts` after each
    test. `endSandboxRun` first sends SIGKILL to every live child's group. It then waits 200 ms,
    a blocking wait since on `exit` nothing scheduled runs again, because a write already under
    way (a `mkdir -p` above all) can land after the removal and bring the directory back. Only
    then does it remove both directories. A stage's group is now sent SIGKILL whenever the stage
    settles, a pass included. Before, only a stopped or interrupted stage's group was, so a member
    a passed stage left running with no pipe open went on writing into the scratch dir until pup
    exited. That writer is the `ENOTEMPTY` that crashed pup at exit. Decision 95 already reported
    that failure instead of throwing, and the writer is now gone before the removal. A removal
    that still fails is reported as decision 95 has it. `withScratchGitDir`'s removal now goes
    through `removeGateDir` too, so it no longer throws over the push or land it ran.
    Ceiling: a process that left its group, as a daemon that calls `setsid` does, is out of reach,
    and the directory it writes in is reported, not removed. `pup-toolchain-cache` itself stays,
    as designed. The fake vitest in `merge-gate.test.ts` logs its runs in the toolchain cache,
    the one place a child writes that outlives the gate, and removes the log afterwards.
    Measured: two full suite runs in one private `TMPDIR` leave `pup-toolchain-cache` and nothing
    else of ours, with no repo cache inside it. Before the change, one run left 1,885 entries.
    Tests: a straggler a passed stage started in its group is dead once the stage resolves. A
    child still running `mkdir -p` into the scratch dir is killed by `endSandboxRun`, and the
    directory is gone. A `tsx` process that exits with such a child running exits 0, prints
    nothing on stderr and leaves no `pup-gate-` or `pup-sandbox-` behind. A gate that merges and
    one that refuses have each removed their checkout and their children's `TMPDIR` by the time
    they return. Each of these fails with its fix taken out: the unconditional group kill, the
    kill before removal, the 200 ms wait (the exit test, two runs in three) and the gate's call.
    *Amended 2026-10-28 (task t-mvry50b8):* three files written after this decision called
    `mkdtempSync` again and removed nothing: `fix-round.test.ts` (`pup-fix-origin-`, `-gh-`,
    `-repo-`, `-claude-`, `-state-`, `-git-`, `-lookup-`), `ci-wait.test.ts` (`pup-ci-wait-`) and
    `github-client.test.ts` (`pup-review-gh-`). About 76,000 `pup-*` entries had piled up again,
    5,355 `pup-fix-origin-` in one day. They now make every directory through `tempDir`. Each of
    them also guards itself: `beforeAll` points `TMPDIR` at a directory of its own, so whatever
    the file and its children make lands there and no concurrent run's entries do, and `afterAll`
    restores `TMPDIR`, removes that directory and fails the file if it held a `pup-*` entry.
    `fix-round.test.ts` runs the gate, so its guard keeps `pup-toolchain-cache` but fails on a
    repo cache inside it. Measured: the three files under a fresh `TMPDIR` leave no `pup-*` entry,
    and a test added to `github-client.test.ts` that calls `mkdtempSync` and removes nothing
    fails the file, naming the directory it left.
