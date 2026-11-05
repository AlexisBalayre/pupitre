# 0067. The transcript directory is derived and the stored column only confirmed, and two more raw store strings are scrubbed at the fold (2026-09-23)

- Status: accepted

67. **The transcript directory is derived and the stored column only confirmed, and two more raw
    store strings are scrubbed at the fold (2026-09-23).** Decision 66 closed `sessions.id` as a
    path fragment and named `sessions.transcript_path` as the ceiling left: the same hole one
    column over. `pup` stamps that column at launch as `transcriptDir(worktreePath)`, under
    `~/.claude/projects`, but `dashboard.service.ts` read it back out of a store the sessions
    write and handed it to `latestContextTokens`, which `readdirSync`s, `statSync`s and
    `readFileSync`s it. Since decisions 60-62 that sweep runs over *every* registered project's
    store, so one row could point the operator's own `pup status` or `pup ui` at any directory
    on disk and have the newest `.jsonl` in it opened and parsed.
    *Derive, then compare.* `transcriptDirOf` sits beside `eventsFileOf` in
    `dashboard.service.ts` and has its shape — store text in, a path or nothing out. It derives
    `transcriptDir(row.worktree_path)` and returns it only when the stored column is exactly
    that string; otherwise nothing, and the row reads the way a row whose column is null
    already reads: context unknown, no directory listed and no file opened for it. Confirming
    the column rather than replacing it keeps the store the record of where a session's
    transcript went, and keeps a row pup did not stamp from being read as one it did.
    *The munge is what makes the derivation a guard.* `worktree_path` is session-writable too,
    so deriving from it would be no better than trusting the column — except that
    `transcriptDir` munges with a closed allowlist, every character outside `[a-zA-Z0-9]`
    becoming `-`, which leaves one segment directly under `~/.claude/projects` whatever the
    column held. Separators and dots are not escaped, they stop existing, as decision 66's
    charset does for an id. `session-runtime.test.ts` pins that on a worktree path carrying
    `..` and `/`: the parent is `~/.claude/projects` and the segment holds neither.
    *The empty string is refused before the derivation*, because it is the one input the munge
    does not bound: `join` drops an empty segment, so `transcriptDir('')` is the projects
    directory itself — zero segments under it, not one — and `worktree_path` is `TEXT NOT NULL`,
    which `''` satisfies. A row holding `''` and naming `~/.claude/projects` as its transcript
    directory would otherwise pass the equality check and have the operator's own transcripts
    listed and the newest of them read. `transcriptDirOf` returns nothing for it on its first
    line. Found by the security review of the first cut, which measured the collapse.
    *Two more raw sinks, scrubbed at the fold (decision 29).* `pup brief edit` names the
    windows running on the brief as it was (decision 57) by joining `listSessions` ids into a
    printed line; they are store-read ids on the operator's terminal, so they go through
    `sanitizeReason` as decision 61's do. `activityLabel`'s awaiting-input branch prints a
    Notification hook's own `message`, which `classifySessionActivity` carries through
    untouched, and now scrubs it where it prints it: the classifier stays a classifier, and the
    surface that folds foreign text into a row is the one that sanitizes, as everywhere else.
    *And `pup review`, which was a page of them.* The same review found the queue printing
    `sessionId` and the whole multi-line `goal` raw, and the detail page printing `sessionId`,
    `state`, `branch`, `worktreePath`, `scope-out`, `acceptance` and the stored gate report's
    stage, status and detail raw — beside a `goal` and a `scope-in` that were already
    sanitized. Every string on that page is store-read: the session row, the spec the conductor
    may have written (decision 47), the report the events hold. All of them now go through
    `sanitizeReason`, and the queue's goal through `goalHeadline`, which is what every other
    queue of goals prints (decision 41). The command is fixed whole rather than by the two
    lines the review named, because half-sanitizing one page is what made the raw half easy to
    miss. `state` is scrubbed with the rest though the query that finds the row already pins it
    to three values, so no planted state can reach the print: it costs a call and removes the
    need to re-derive that argument.
    *An unreadable transcript is a reading that degrades, not a surface that dies.*
    `latestContextTokens` listed by name and read outside its own `try`, so a directory named
    `<anything>.jsonl` in a session's own transcript directory threw `EISDIR` out of
    `buildDashboardSnapshot` and took single-project `pup status` and `pup ui` down with it
    (the fleet readers already degrade such a project to one `unreadable:` line). The read is
    inside the `try` now and returns undefined, which is what a directory holding no transcript
    already returns.
    *Tests,* on temp stores with a throwaway `HOME`, as the suites around them already run.
    `dashboard.test.ts` plants a transcript holding a 90k token count in a directory outside
    `~/.claude/projects` and points a running row's `transcript_path` at it: the row reports no
    context, which is only true if nothing listed or opened it. A second plants one in
    `~/.claude/projects` itself against a row whose `worktree_path` is `''`. Their pair points a
    row at the directory `transcriptDir` derives for its worktree and reads the 90k back.
    `transcript.test.ts` puts a directory named `newest.jsonl` in a transcript directory.
    `dashboard-text-utils.test.ts` is new — `activityLabel` had only the Ink frame in
    `dashboard-components.test.ts` — and drives the label with a control character in the hook's
    message. `index.test.ts` runs `brief edit` over a running session whose id carries one, and
    gains the first tests `pup review` has had: a queue row and a detail page whose every stored
    string carries an escape. They needed `countChangedLines` added to that file's
    `merge-gate.service` mock, which is why the command had none.
    *Two existing cases changed.* `index.test.ts`'s two fleet readings that fail on one project
    used an unreadable transcript to make a snapshot throw, which it no longer does; they use an
    unreadable events file instead, which is the same shape — a file the reader finds and cannot
    read — and they assert the same `unreadable: …EACCES` line.
    *The discriminating mutations*, each run against a backup copy and restored from it.
    Returning the stored column instead of comparing it fails the planted-transcript test on
    `expected 90000 to be undefined`, which is the planted file read. Dropping the empty-string
    line fails its test the same way. Widening the munge to `[^a-zA-Z0-9/.]` fails the traversal
    test. Taking the read back out of its `try` fails the directory test on `EISDIR`. Dropping
    any of the `sanitizeReason` calls fails its own test and nothing else.
    *Ceilings.* The comparison proves the directory is the one pup would stamp for that row's
    worktree. It does not prove pup stamped it, and it says nothing about what is inside. A
    session writes its own transcript directory, so the newest `.jsonl` there is whatever it
    put there, and `readFileSync` follows symlinks: a session can link
    `~/.claude/projects/<its own munged dir>/x.jsonl` at any file the operator can read, since
    `HOME` is the operator's by decision 28. What surfaces from that read is a token count and
    nothing else — the file's content never reaches a surface — which is strictly narrower than
    the whole directory listing a planted `transcript_path` bought before this change, and it
    is the same store-and-agent trust boundary decision 66 left.
    *And the raw sinks still left,* each store-read text printed to the operator's terminal
    unsanitized, and each its own task: `pup watch`'s overlap session ids
    (`index.ts`, from `overlap.service.ts`, where `dashboard.service.ts` sanitizes the same
    pair), `pup ledger`'s `entry.description` (which interpolates a store-read session id), and
    `pup log`'s `summary`, `alternatives` and `conventions`. Nothing in this task touches them.
    **Closed by decision 68**, which scrubbed all three, the two sinks named beside them, five
    more a source scan found, and put that scan over `index.ts` in the way of the next one.
