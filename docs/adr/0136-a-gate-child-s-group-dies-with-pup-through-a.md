# 0136. A gate child's group dies with pup, through a lifeline watcher in the group (2026-11-07)

- Status: accepted
- Amends: [0095](0095-the-gate-pup-audit-and-pup-land-run.md), [0100](0100-every-temp-directory-a-test-makes-is-removed.md)

136. **A gate child's group dies with pup, through a lifeline watcher in the group (2026-11-07).**
    Amends decisions 95 and 100. Decision 95 put every gate child in a process group of its own,
    in a session of its own, and decision 100 kills what is left in that group when the child
    settles. Both kills are pup's, so both need pup alive to run them. On 2026-11-07 a `sh` from
    `sandbox-utils.test.ts`'s TERM-ignoring timeout test was found under launchd (ppid 1) after
    3 days 10 hours, forking `sleep` ten times a second, about three million execs, each one
    scanned by the endpoint-security daemon, and an earlier `mkdir` loop in `TMPDIR` was the
    same leak. The kill escalation itself was sound. What let the child escape was pup dying
    inside the grace: vitest stops a worker with SIGTERM and SIGKILLs it 500 ms later. pup's
    forwarder caught the SIGTERM, so the worker did not exit, and passed it on to a group that
    ignored it. The 5 s SIGKILL it armed then never ran. The gate leaks the same way when it
    gates itself: the outer gate's timeout stops its own group, which holds the inner pup but
    not the inner pup's children, since those are in their own sessions, and the outer gate's
    SIGKILL lands before the inner grace runs out. So does a pup killed by an OOM or by `kill
    -9` while a stage runs.
    macOS has no parent-death signal, so `runGateChild` now spawns every child through a
    `/bin/sh` lifeline (inside the sandbox, which `sandbox-exec` still wraps around it). It
    forks a watcher that ignores HUP, INT and TERM and blocks reading a fourth stdio pipe whose
    other end only pup holds. Then it execs the command with that fd closed and the signal
    dispositions reset. When pup's end closes, which the kernel does however pup dies, the
    watcher's read returns and it sends SIGKILL to its own group. The command is still the
    process pup spawned, so its status and signal are its own, and nothing it starts inherits
    the lifeline. Node's `'close'` waits for the lifeline pipe too, so pup closes its end once
    the child has exited and its stdout and stderr have closed, the moment `settle` already
    kills the group. Waiting on the output pipes keeps decision 100's behaviour that a group
    member still writing output is read to the end. Failure messages name the command the
    caller passed, not the wrappers. `runGateChildSync` is left as it was: its child is not
    detached, so it stays in pup's own group, where whatever stops pup's group stops the child.
    A watcher there would kill pup's own group.
    What is still out of reach is what decision 100 already named: a process that leaves the
    group (a daemon calling `setsid`). Rejected: a watcher polling pup's pid, which forks once a
    poll for the life of every stage (the exec load this decision exists to end) and can be
    fooled by pid reuse; and a shorter grace, which narrows the window without closing it.
    Tests: the timeout test asserts that nothing in the child's group is alive after
    `runGateChild` rejects; a pup that runs a TERM-ignoring child, gets SIGTERM and is SIGKILLed
    500 ms later, as vitest does, leaves nothing in that child's group (the test fails without
    the lifeline and kills the group it leaked).
