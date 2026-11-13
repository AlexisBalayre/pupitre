# 0184. Long-running commands keep one stage line on stderr, and the merge lock says who holds it (2026-11-11)

- Status: accepted

184. **Long-running commands keep one stage line on stderr, and the merge lock says who holds it (2026-11-11).**
    *The line.* `pup land`, `merge`, `audit`, `fix`, `respawn` and `ci wait` keep a status line on
    stderr, `stage N/M, <name>, <elapsed>`. The elapsed time counts from the command's start. Each
    command's stages are a fixed list in `progress.utils.ts`, in the order they run. A stage that
    does not run is skipped, so the numbers can jump. `pup merge` counts its suites, lint and debt
    measurements as one stage, `tests and checks`, because they run at once. On a terminal the line
    is rewritten in place (`\r` and an erase-line) and ticks once a second. Off a terminal each
    stage change is one plain line, with no cursor control and no colour. stdout is left as it
    was, so the conductor and hooks parse the same text as before. There are no percentage bars,
    since no stage knows its own length, and no new dependency. The line is cleared before the
    command prints its outcome or a refusal. A message printed during a stage goes through the
    line's `note`, which prints it on a line of its own. Callers with no status line (the
    conductor's in-process calls, the tests) get one that prints nothing but those notes, on
    stderr as before.
    *The merge lock.* While held, the lock directory keeps a `status` file beside its `pid`: the
    holder's command line, when it took the lock, and its current stage. The holder writes it
    under a fresh name and renames it into place. It writes only while the lock path is still the
    directory it took, so nothing is written through a link or into a file a session planted. The
    release and the reclaim remove it with the pid. A waiter reads it as it reads the pid: no link
    followed, no fifo opened, any malformed file ignored, every field scrubbed. `pup land` and
    `pup merge` then print `Waiting for the merge lock, held by pid N`, followed in brackets by the
    holder's command, how long it has held the lock and its stage, then the longest they will
    wait. They print it again whenever the holder or its stage changes. A lock with no status, such as one an earlier pup took or one made by
    hand, prints today's line unchanged. Nothing decides on the status: it is for the operator to
    read.
