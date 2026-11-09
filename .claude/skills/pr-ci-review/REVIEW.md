# Review rounds and merge

The rules a PR's review rounds converge on. The review reads this file from the base: CI restores `.claude/` before the model starts, so a PR cannot rewrite the rules it is judged by. Severity (`important`, `nit`, `pre-existing`) is defined in `SKILL.md` §Review Constraints; "minor" below means a `nit` or a `pre-existing` finding.

Three rules, each standing on its own.

## 1. The round rule

- **Rounds 1 to 3:** the author fixes every minor the review lists, a pre-existing one included when the fix is small. A review lists at most five minors, nits before pre-existing, and says how many it held back; held-back minors are not owed.
- **Round 4 on:** the author fixes each `important` §2 makes blocking, carried ones included. A minor no longer needs an answer, and nits alone never justify another round.

A round's delta is the PR's own changes from the head the previous complete round reviewed to the head this round reviewed. When the base branch changed since then, or that head is not an ancestor of this one, the delta is the whole PR. An `important` is on the delta when the delta's hunks hold a line it names, or the delta introduced it.

## 2. Importants block

An `important` that rounds 1 to 3 raised, or that a later round raised on its delta, is fixed before merge, carried or new. It is never deferred: a reply that answers one leaves it unresolved. An author who believes one is wrong answers it with code evidence, in its thread; the user decides. A PR whose important the user rules wrong merges with it still listed, since a later round re-checks only the head, never the author's challenge.

From round 4, an `important` raised off the delta is not blocking: the author posts once, on its thread, `Off the delta of round N (<sha>): not blocking (REVIEW.md §2).` and leaves it open for the user.

## 3. The merge rule

A PR is ready to merge when the latest review on its head has:

- zero open blocking importants (§2), apart from one the user ruled wrong;
- on a head of rounds 1 to 3, every listed minor fixed or deferred (below). From round 4 an open minor no longer counts.

The user decides ready and merges.

## Deferrals

Only the author defers, and only a minor. A reply with a reason in the minor's thread, or a `Round N (<sha>), disposition: <what and why>` line in the PR body, counts as the deferral. A bare "later" is not one.
