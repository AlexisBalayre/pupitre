# 0165. pr-status reads unthreaded importants from the review body (2026-11-09)

- Status: accepted

165. **pr-status reads unthreaded importants from the review body (2026-11-09).**
    `pr-status.yml` labelled a PR `ready` once the `claude-review` status description named no
    important and no bot review thread was open. Two kinds of important have no thread: one with
    no line in the diff to anchor to, and one an incremental round carries from the prior round
    ("still open (not raised again)"). The poster lists both only in the summary review's body, and
    a push replaces the status description. So #278 and #281 read `ready` with an important open.
    *The rule.* The workflow takes the newest review by `github-actions[bot]` whose body starts
    with `REVIEW_HEADING` and counts the importants its count lines name. Any count above zero is
    `review-open`.
    *Where the parser lives.* Inline in the workflow's github-script step, as
    `unthreadedImportants`. That job holds a write token, readable in its environment as
    `INPUT_GITHUB-TOKEN`, so every line it runs stays in `.github/workflows/`, where a change is
    reviewed as a workflow change. `tools/review/test/unit/pr-status-workflow.test.ts` cuts the
    function out of the YAML and runs it on bodies `bodyLines` renders. It also checks the inline
    `REVIEW_HEADING` against the poster's. A reworded count line then fails the test rather than
    clearing a PR.
    *Not taken.* A parser module in `tools/review/src` that the job loads from a checkout of the
    default branch. It is easier to test, but any later edit to that ordinary file would run with
    the write token while being reviewed as tooling. A file the job `require`s could also throw on
    the runner and freeze every label. Having the poster count carried importants in the status
    description: a push replaces that description with the push marker, so the label would read
    `ready` from the push until the next review, the gap this closes.
