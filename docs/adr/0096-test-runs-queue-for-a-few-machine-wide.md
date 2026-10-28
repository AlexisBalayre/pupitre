# 0096. Test runs queue for a few machine-wide slots, the gate's first; launches stop at a per-project session cap and under 1.5 GB of available memory; the conductor fills the cap with tasks that share no source file (2026-10-18)

- Status: accepted
- Amended by: [0088](0088-the-merge-lock-records-its-holder-survives-every.md), [0119](0119-the-session-cap-counts-working-sessions-not-those.md)

96. **Test runs queue for a few machine-wide slots, the gate's first; launches stop at a
    per-project session cap and under 1.5 GB of available memory; the conductor fills the cap
    with tasks that share no source file (2026-10-18).**
    The aim is 6 to 8 workers on one machine. What limits them is the CPU of test runs, not the
    sessions, which spend most of their time thinking and editing. So test runs wait their turn
    and sessions do not.
    Slots. `pup session test [args]` runs the test command of the repo's first adapter, the same
    one the gate's test stage runs (decision 22), with the arguments after it, only once it holds
    one of the machine's test slots, 2 by default. There is no related-test form in the adapter
    yet, so a worker names its test files. npm gets a `--` before them, and a custom adapter's
    `sh -c '<cmd>'` gets `sh` as its `$0`, so the files reach the script as `"$@"`, its text
    untouched; a script that does not use them runs as it would in the gate. A slot is a lock file
    `slot-N.lock` in `~/.pupitre/slots` holding the holder's kind, label, pid and a token. A take
    writes a staged file and hard-links it into a free slot name, so two takers cannot both win
    one. A staged file gets a fresh random name, never the token a gate's wait file publishes,
    and an exclusive open (`wx`), so a fifo or a symlink a session plants at one fails at once
    and is neither blocked on, which would freeze the gate's wait past its bound and its
    signals, nor followed. A slot is reclaimed when its pid is not a live process of this user (`kill(pid, 0)`;
    EPERM means another user's, such as pid 1, which holds no slot under this home), or when it
    is not a regular file or its record does not parse: renamed aside, re-read, and linked back
    if its holder turns out alive. Slot and wait files are read only after a non-blocking open
    that does not follow a symlink (`O_NOFOLLOW`) shows a regular file (`readPlainFile`, moved
    from the TypeScript adapter to the capability utils for this), and the read stops at 1 MiB
    rather than at EOF, since a procfs file such as `/proc/self/pagemap` is regular, reports
    size 0 and streams for hundreds of gigabytes. So a fifo, a link or a procfs file planted
    there is reclaimed, never blocked on, followed or read without end. The TypeScript adapter's
    reads keep the size cap but follow links, as a checkout may track its config as one. A
    release removes the slot only while it still holds the run's own token. While it waits, the
    run prints once whom it waits for, `Waiting for a test slot, held by session t-1 (pid 4242)
    and the merge gate for t-2 (pid 4343); the merge gate for t-3 waits first.`, labels passed
    through `sanitizeReason`, and polls each second. The child runs with `PUP_TEST_SLOT` set, its
    signals forwarded, and its exit status (128 plus the signal's number when killed) becomes the
    command's. Ctrl-C or SIGTERM during the wait ends it with exit 130 and no run.
    The gate first. The gate's test run, the root's and every touched nested package's together,
    takes one slot too, and only when there is a suite to run. A waiting gate stages
    `gate-<pid>-<token>.wait` the same way and renames it in, so no worker reads it empty and
    removes it as a dead gate's; no worker takes a free slot while a live gate's wait file exists,
    and a dead gate's file is removed. Waiting gates race among themselves, as do waiting workers.
    The gate waits under the merge lock and the slots are every project's, so its wait is
    bounded: after a stage's own timeout, 10 minutes (`GATE_SLOT_WAIT_MS`), it prints `No test
    slot came free in 600.0s; the gate runs its tests without one.` and runs them. A holder that
    keeps a slot longer than the gate lets one of its runs go is hung, or holds no test run at
    all. A worker ignores a gate's wait file older than that bound, or dated ahead of now.
    Worker waits are not bounded: a stuck holder stalls only sessions' own test runs.
    Nor can a broken slots path fail the gate: when the slots cannot be used at all, such as a
    regular file or a symlink loop planted at `~/.pupitre/slots`, or a directory planted as
    `slot-N.lock` that Linux will not unlink, the gate prints `The test slots could not be used
    (<reason>); the gate runs its tests without one.` and runs them. An interrupt still ends it.
    A worker's `pup session test` fails with that error instead, as only sessions broke it.
    The wait happens before the test stage starts, so it is not part of the stage's time. The
    merge lock's listener (decision 84) holds signals, so the wait listens for SIGINT and SIGTERM
    itself and ends the gate as `GateInterruptedError` would, removing the coverage run's report
    directory. A run with `PUP_TEST_SLOT` already set takes none, so a gate run inside a session's
    test run does not wait on the slot its parent holds. A gate inside a sandbox that keeps
    `~/.pupitre` from it (EPERM, EACCES or EROFS on the slots directory) runs without one.
    The guard. Every compiled session profile adds a Bash PreToolUse hook, `test-guard.sh`, that
    refuses with exit 2 a command matching a pattern in its sidecar `test-runner.pat`: vitest or
    jest run directly, through npx, bunx, pnpx, a package manager's exec, dlx or x, or a bin path;
    `pnpm|yarn|npm|bun [run] test`; and the adapter's own test command, its words escaped. For a
    custom adapter's `sh -c '<script>'` those are the script's own words, the ones a session
    types, less a trailing `"$@"`. A one-word script is refused only bare, followed by nothing
    but a separator or a redirection, since the word may be a driver like `make` whose other
    targets are no test run. A script that is more than plain words (quotes, `$`, operators, a
    line break) gets no pattern. A
    pattern matches at a command's start or after `;`, `&`, `|`, `(` or a backtick, behind any
    `VAR=value`, `env`, `exec`, `command`, `time` or `nice`. The message names
    `pup session test`. The session protocol's test line now says to run tests only with
    `pup session test <test files>`, naming the tests related to the change. The conductor's
    context says a session waiting on a slot is not stalled.
    The cap. `pup conductor start --max-sessions <n>` (default 4, a whole number of at least 1)
    stores the cap in `~/.pupitre/<project>/conductor/max-sessions` and prints it. `pup launch`
    and `pup new` count the project's sessions in a holding state and refuse, before anything is
    written, once that count reaches the cap, for the conductor and the operator alike. A
    missing file, one holding no positive whole number, a symlink, or one that is not a regular
    file, means 4, read the way slot files are. `--over-cap` lets the operator past it. The conductor passing it
    is refused at the CLI, and a launch made through the conductor ignores it.
    Decision 99 puts no cap on how many sessions may share a file; this cap counts every live
    session, overlapping or not. A `pup fix` round (decision 90) brings a merged session, which
    is not counted, back to a live window, so it meets the cap and the memory floor below before
    anything is written, and has no `--over-cap`: the operator waits, or restarts the conductor
    with a larger cap.
    Memory. A launch also refuses when the machine has under 1.5 GB of memory available, naming
    the figure in GB. On macOS that is free, inactive and speculative pages from `vm_stat` at its
    page size, and elsewhere, or when `vm_stat` gives nothing, `os.freemem()`. `--over-cap` does
    not lift it.
    Scheduling. The conductor's protocol keeps the cap's number of sessions live. Whenever fewer
    are live, it fills the free places with planned tasks whose scope-in globs share no source
    file with a running session's, at most one session per task. The decisions document and the
    file that registers CLI commands do not count as shared. A task that shares other files
    waits until every planned task does, and is then launched under decision 99.
    Ceilings: a reused pid keeps a dead holder's slot looking alive until that process exits. Two
    reclaimers racing over one dead slot can over-subscribe it by one run. The guard is best
    effort, as is the gate's priority: both are fairness among cooperating sessions, not a
    boundary. A script that runs the test runner, or a route the patterns miss (`node
    node_modules/vitest/vitest.mjs`, `pnpm -C . test`, `npx --yes vitest`, `sh -c 'vitest'`),
    runs unqueued, as does a custom adapter's script beyond plain words, or its words with other
    arguments in place of its own (`go test ./pkg` for `go test ./...`); a session that sets `PUP_TEST_SLOT` skips the wait; one that forges a slot
    naming a live process of its own, or backgrounds a hung `pup session test`, holds slots
    until the gate's bound runs out; one that breaks the slots path makes every gate run without
    a slot and every worker's `pup session test` fail until the operator removes what it
    planted. The cap file and the store are writable by session and
    conductor code, as decisions 46 and 47 say of the store, so a session can rewrite the cap.
    Fixing the cap at the conductor's start was weighed and not done: every place it could live,
    the compiled directory, an environment variable, the conductor's settings, is as writable
    from the conductor's shell, which can also drop `PUP_CONDUCTOR` and pass `--over-cap`
    (decision 27's ceiling), so the cap is an operator's setting the conductor follows, not one
    it cannot change. A gate
    run outside any sandbox and outside `pup session test`, such as a test that runs the gate,
    takes real slots unless `PUP_TEST_SLOT` is set.
    Tests: three runs with two slots run two and start the third when one ends; a dead holder's
    slot is reclaimed and a live foreign holder's is not, while one naming pid 1 or planted as a
    fifo is reclaimed without blocking (the fifo test hangs on the old read), and so is a symlink
    to a live holder's record, its target untouched; `readPlainFile` refuses a link only when
    told to, and stops at the cap on a file that reports size 0 while holding 2 MiB (the test
    fails on a read to EOF), and refuses `/proc/self/pagemap` where there is one, at the cap or
    on the kernel's refusal of the read, since no Linux runner checks which; a fifo planted at a
    staged file fails a gate's wait and a worker's take at once, the gate running without a slot
    (the test hangs on a plain open); a gate is served
    before a worker that waited longer and is named to it; a dead gate's wait file, and a live
    one's older than the bound, are ignored; a run whose longest wait runs out runs without a
    slot and says so, and so does a gate, merging with both slots still held; a file planted where
    the slots go runs a gate without one, saying so, and fails a run with no fallback; a custom
    adapter's `sh -c` script gets the files as its arguments; a slot is freed on a
    throw and left alone once another run took it; `PUP_TEST_SLOT` and an unwritable directory
    run without a slot. In the gate, a gate with both slots held waits and prints whom for, and a
    worker stays waiting behind it after a slot frees. The compiled settings refuse pnpm test,
    vitest, npx vitest, wrapped and chained forms and the adapter's command, allow the rest, and
    wire the guard. A custom adapter's `sh -c` script, read from a real `adapter.yml`, is refused
    on its own words less `"$@"`, a one-word `make` only bare (`make build` passes), and a script
    beyond plain words, `"$@"` alone or a blank one gets no pattern and lets `git status` through. Launch and `pup new` refuse at the cap for both callers with nothing launched,
    killed sessions are not counted, the operator's `--over-cap` passes and the conductor's never
    does; a fix round's recompile goes ahead below the cap and is refused at it and under the
    floor; under 1.5 GB, read from a faked figure, a launch refuses naming it, even with
    `--over-cap`. The cap is stored and read back with its default, also for a fifo or a symlink
    planted as the file; the CLI passes and refuses
    the flags, and `pup session test` passes its arguments and exit status.
