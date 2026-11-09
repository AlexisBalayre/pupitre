# 0163. Every unresolved, non-outdated review thread counts as open (2026-11-09)

- Status: accepted
- Amends: [0090](0090-pup-fix-session-hands-the-ci-review-s.md)

163. **Every unresolved, non-outdated review thread counts as open (2026-11-09).**
    Amends decision 90, which counted only the threads the bot's newest review run opened, on
    the grounds that "the review of the head raises again whatever it still finds", so that a
    clean newest run read clean. On #284 at 314b44a it did not raise it again. An important
    thread from an earlier run on the same head (`src/core/test-slot.service.ts:512`) stayed
    unresolved. Even so, `pup ci wait` reported "0 open thread(s) → ready for the operator's
    merge click", and `pup fix` refused to start a round because the status read clean. A
    newer run's silence is not an answer to a finding.
    *The rule.* `readPullRequestReview` (`github.client.ts`) now reads `isOutdated` on each
    review thread. `openThreads` holds every thread that is unresolved, not outdated, and whose
    first comment is the bot's, whichever of its runs opened it. Only a plain `true` makes a
    thread outdated, so a field outside its shape leaves the thread open. An outdated thread is
    one whose line a later push changed. GitHub's own signal for that is the one
    `tools/review` already reads as "fixed". The review's verdict on the head is then the bot's
    newest review plus every finding still standing on it. `pup ci wait` therefore names
    `pup fix` rather than the merge click whenever one remains. Under the bot's `SUCCESS`
    status, `pup fix` hands every one of them to the round, and that includes the clean
    `no blocking issues`. The edited-or-hidden refusal now covers all of them, not only the
    newest run's.
    *A thread a round answered.* A fix round replies on every thread it relays, but resolves
    only the ones it addressed. A declined, unanswered or unverified thread stays open for the
    operator, and the round's push usually leaves its line alone, so it is not outdated either.
    Relaying it again would hand the worker a finding it already declined, with no sign that it
    did, and would count as a `repeat-fix-round`. Each thread therefore carries `isAnswered`,
    read from `lastComment: comments(last: 1)`: its last comment is pup's own
    (`viewerDidAuthor`) and carries the `<!-- pup fix-round ` marker that `fixRoundMarker`
    builds. Such a thread still counts as open, so the PR does not read ready. `pup ci wait`
    names the operator, not `pup fix`, when the answered ones are all that remain. `pup fix`
    relays only unanswered threads and refuses when nothing else is left. Any comment after
    pup's reply, whether the operator's or the bot's, makes the thread live again, and the next
    round takes it. The answer is read from GitHub, not from the `fix_round` events, so the
    reply itself is what marks it.
    *What is gone.* The newest-run grouping goes. That was the bodiless reviews the poster's
    one-finding-at-a-time fallback leaves, matched through each thread's
    `pullRequestReview.id`. The newest bot review's commit is still `reviewedHead`. The
    reviews' `id`, `body` and `comments.totalCount` are no longer queried, and neither is the
    thread comment's `pullRequestReview`.
    *The page cap.* Decision 90 refused a PR past the newest 100 threads only when the newest
    run's comment count said some of its own were unread. Any older thread can now be open,
    so a PR with threads past the page (`hasPreviousPage`) is refused outright: fix it by hand.
    Resolved threads count toward the 100, so a PR that ran many rounds hits the cap sooner
    than it did. Paging back through older threads was not taken. One read keeps every field
    describing the same moment.
    *Unchanged.* A thread must still be the bot's to count or be relayed. A human's thread
    remains the operator's to answer. Threads still relay only under the bot's `SUCCESS`
    status on a head its newest review is on. Any other status points at `@claude review`, as
    before.
    *Tests.* In `github-client.test.ts`, a thread an earlier review left open is read, whether
    its `isOutdated` is `false` or unreadable, and an outdated one is not. A PR past the page is
    refused even when the thread on the page is resolved. In `ci-wait.test.ts`, a clean status
    with one open thread and two outdated ones names `pup fix`. In `fix-round-kickoff.test.ts`,
    a clean status with an open thread and an outdated one starts a round on the open one only.
    `isAnswered` is read only for a marked last comment of pup's own. When a round's answered
    threads are all that remain, `ci wait` names the operator and `pup fix` refuses, but an
    answered thread beside an unanswered one leaves the round to relay only the unanswered
    one.
