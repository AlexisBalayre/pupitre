# 0199. A compaction restarts from live state, read by a SessionStart hook, not from the summary (2026-11-18)

- Status: accepted
- Amends: [0018](0018-context-is-optimized-by-handoff-respawn-not-in.md)

199. **A compaction restarts from live state, read by a SessionStart hook, not from the summary
    (2026-11-18).** Decision 18 chose handoff-respawn over `/compact`, but windows still compact:
    Claude Code compacts on its own near the window's end, and a worker or conductor that runs past
    its respawn compacts all the same. Decision 18 said the summary was lossy. On 2026-11-16 that
    loss was measured over 8 compactions: 71% of state facts survived in full and 17% in part. In
    one of them the conductor reported six fix rounds as still running that had all finished. A
    window resumed after a compaction acts on the summary's memory of state that the store and git
    hold exactly.
    *The rule.* Every compiled profile, a worker's and the conductor's, carries a `SessionStart`
    hook matched on `compact` and only on it. A startup, a resume and a clear stay as they were. The
    hook prints the live state, which Claude Code adds to the context right after the summary,
    under a heading saying it was read just now and that where the summary disagrees, it wins.
    - A **worker's** `hooks/compact-recap.sh` reads git first, in shell, under the worktree hooks'
      pin and read deadline (decisions 101, 124): the branch and its head, the commits past the main
      checkout's HEAD (the first 10), and the uncommitted files (counted, the first 20 listed). It
      then runs `pup session recap` from the worktree, bounded by a deadline of its own, for the
      store's side: the session's state, its rejections and any CI fix round it is in, the last gate
      verdict (passed, or the stages it failed at), and the question it asked the operator that is
      still unanswered. The git half is in shell so that the branch head prints when pup or the
      store cannot be reached.
    - The **conductor's** runs `pup conductor recap` from the main checkout: the sessions by state,
      the five active states naming their ids and marking those in a fix round, merged and killed
      only counted; each open PR (a session not killed whose newest `merge`, `landed`,
      `retired` or `pr_closed` is a merge with a PR) with three heads; who holds the merge lock, what it
      runs and at which stage (decisions 88, 184), or that its pid is gone; and the conductor's own
      unanswered question. A PR's three heads are its gate pin (the merge's `sha`), `origin/<branch>`
      as pup's push last moved it, and the worktree's HEAD, and a worktree past its pin is flagged as
      holding commits no gate measured. `pup conductor recap` is the operator's too; a session is
      refused it and pointed at its own.
    *The bounds.* The hook is read-only: it runs no write, takes no lock (`GIT_OPTIONAL_LOCKS=0`,
    as `safe_git` does) and makes no network call. The PR head is the local tracking ref, which
    can be stale against GitHub, never a `gh` read. Its output is cut at 5000 bytes, 1.25k tokens
    at four characters a token and under 2k even at the two and a half that hex ids come closer
    to. Each list it prints is capped at 12 entries, the rest counted. It always exits 0. A read
    that fails prints its line as `unreadable` or the state as `unknown`, with the command to retry,
    and never fails the session's start. The worker's store read and the conductor's git reads each
    have a budget inside the hook's timeout, so a pup or a git that hangs costs its own lines and
    not the ones already read. Text a session can write (ids, stage names, question text, the merge
    lock's status file) is scrubbed with `sanitizeReason` (decision 68). The lock is read as the
    gate reads it, with no link followed and no fifo opened.
    *What stays.* Decision 18 stands: respawn is still how pup trims a context. This decision only
    makes a compaction that happens anyway restart from the record rather than from recall.
    *Ceilings.* The recap is what the store and git hold when it runs. A gate run in flight shows
    as the merge lock's stage, not as a verdict. A worker's status lists paths as `git status
    --porcelain` quotes them. The merge-lock reader repeats the gate's private one, kept apart
    because exporting it would widen `merge-gate.service.ts` for a second reader. The conductor's
    hook has no deadline of its own on pup, so it relies on the hook's timeout, and a pup that
    hangs there loses the whole recap, which only tells the window nothing new.
