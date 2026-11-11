# 0174. Review runs in stages, and an important finding needs a failing scenario (2026-11-11)

- Status: accepted

174. **Review runs in stages, and an important finding needs a failing scenario (2026-11-11).**
    *The stages.* Reviewers run before a PR exists and after it opens, each stage with its own set.
    - Per commit, and self-review before push: correctness, docs and conventions, on the commit's
      diff and then the whole diff. Per-commit review runs under the ticket's token budget
      (decision 177) and falls back to self-review alone when the budget is spent.
    - PR round 1: every reviewer whose gate matches the diff, plus Profiling when the diff
      touches the gate, the store or the git clients.
    - PR round 2, the last: only the reviewers whose findings were fixed, plus the validator.
      Whatever is still open then becomes a Follow-up ticket (decision 176), except a
      blocking high below.
    - Design review: spec, security and maintainability. Ticket close: Profiling, the Data
      Protection rubric and context.
    *Important means a failing scenario.* A finding carries `scenario`: the input or state, then
    the wrong result. A test-adequacy finding counts only when it names a concrete mutation of
    the code that the tests would not catch. A finding with neither is demoted to minor. Minor
    findings never start a fix round.
    *The validator reproduces.* It no longer tries to refute: it writes or runs a failing test, or
    applies the named mutation, and an important it cannot reproduce is demoted. Over 45 review
    runs it refuted one of 22 important findings, so refutation bought little.
    *The arbiter.* An Opus agent rules once, only when the author disputes a finding.
    *Docs findings are minor,* except a doc that contradicts the code or an ADR, which stays
    important because a later session will follow it.
    *Blocking highs.* A Security or Data Protection high is never deferred. A new short session
    fixes it and the reviewer re-checks. If it still holds after round 2, the PR goes to the
    operator's queue and only the operator can override it, with the reason recorded in the PR.
    *Roster.* Correctness and security stay on Opus, and the rest on Sonnet. QA folds into
    correctness: each acceptance criterion needs a test that fails without the change. Data
    Protection is a rubric inside security until it produces a finding. A reviewer with no
    important finding in the next 30 merged PRs is removed.
    *Duplicates and yield.* The consolidator merges a duplicate into one finding that credits every
    reviewer who raised it. The `ci/review-metrics` records gain, per finding, whether it was
    validated, demoted or declined by the operator, so each reviewer's yield is computed from
    them. A short list of the finding types the operator accepted or declined most goes into the
    reviewer's prompt and the worker's kickoff brief.
