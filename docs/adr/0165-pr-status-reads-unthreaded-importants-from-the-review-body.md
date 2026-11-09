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
    `review-open`. The parser is `unthreadedImportants` in `tools/review/src/review-status.utils.ts`,
    which also holds `REVIEW_HEADING`. Its unit test reads bodies `bodyLines` renders, so a reworded
    count line fails the test rather than clearing a PR.
    *How the workflow runs it.* A sparse checkout of that one file, from the default branch named
    explicitly: a `pull_request_review` run's own ref is the PR's merge ref, which is PR code. The
    job's github-script `require`s the `.ts` file and Node 24 strips its types. So the file imports
    nothing and uses only erasable syntax, and no install runs in a job that holds a write token.
    *Not taken.* Keeping the parser inline in the workflow script: no test could reach it short of
    cutting the function out of the YAML. Having the poster count carried importants in the status
    description: a push replaces that description with the push marker, so the label would read
    `ready` from the push until the next review, the gap this closes.
