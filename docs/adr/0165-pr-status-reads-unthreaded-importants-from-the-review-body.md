# 0165. pr-status reads unthreaded importants from the review body (2026-11-09)

- Status: accepted

165. **pr-status reads unthreaded importants from the review body (2026-11-09).**
    `pr-status.yml` labelled a PR `ready` once the `claude-review` status description named no
    important and no bot review thread was open. Two kinds of important have no thread: one with
    no line in the diff to anchor to, and one an incremental round carries from the prior round
    ("still open (not raised again)"). The poster lists both only in the summary review's body, and
    a push replaces the status description. So #278 and #281 read `ready` with an important open.
    *The rule.* The workflow takes the newest review by `github-actions[bot]` whose body starts
    with `REVIEW_HEADING` and that reached a verdict. It counts the importants that review's count
    lines name, and any count above zero is `review-open`. A no-verdict or incomplete round lists
    no findings. If it counted, its empty body would clear importants the preflight still treats
    as owed, since the preflight never takes that record as the prior.
    *Carried importants that have a thread.* `prior_importants` holds every important of the prior
    record, including the ones its round anchored inline. Those keep their bot thread. Once the
    operator resolves that thread to accept a declined finding, the code at head is unchanged, so
    every later round lists the finding again. Counted from the body alone, it would hold the PR
    in review for good. So a carried entry whose `path:line` matches a bot thread, resolved or
    not, is left to that thread. A thread's line is its `originalLine`, or the line in its
    `Re: path:line` prefix when the poster pulled the comment to the nearest diff line. A carried
    entry that names no line, or matches no thread, still counts.
    *The operator's override (2026-11-11).* An unanchored important the operator declines has no
    thread to resolve, and the next round carries it, so every later summary counts it. The
    operator adds the `review-accepted` label instead. Only someone with triage access can label a
    PR, and adding or removing it recomputes the label. It holds while it is on and was added after
    the newest summary review with a verdict, read from the PR's issue events. It then accepts
    that round's unthreaded importants and the status description, whether that round's or the
    push marker that replaced it. Open bot threads still count. A later summary lapses it, and the
    workflow removes the lapsed label, so a new round's importants are never waved through unread
    and the operator sees they must decide again. Added in the same second as the summary, it
    could predate it, so it does not hold. *Not taken:* a label that holds until removed, which
    would hide every later round's new importants. A per-finding accept (an owner comment naming
    `path:line`): a round's own unanchored finding may name no line, and the job would have to
    run on `issue_comment`, an event any outsider can start.
    *Where the parser lives.* Inline in the workflow's github-script step, as
    `unthreadedImportants`, `isVerdict` and `acceptedSince`. That job holds a write token, readable in its environment as
    `INPUT_GITHUB-TOKEN`, so every line it runs stays in `.github/workflows/`, where a change is
    reviewed as a workflow change. `tools/review/test/unit/pr-status-workflow.test.ts` cuts the
    functions out of the YAML and runs them on bodies `bodyLines` renders. It also checks the inline
    `REVIEW_HEADING` against the poster's. A reworded count line then fails the test rather than
    clearing a PR.
    *Not taken.* A parser module in `tools/review/src` that the job loads from a checkout of the
    default branch. It is easier to test, but any later edit to that ordinary file would run with
    the write token while being reviewed as tooling. A file the job `require`s could also throw on
    the runner and freeze every label. Having the poster count carried importants in the status
    description: a push replaces that description with the push marker, so the label would read
    `ready` from the push until the next review, the gap this closes. Having the poster mark which
    carried entries were anchored: the poster would have to read the PR's threads to know, and
    the summaries already posted would carry no mark. pr-status reads the threads anyway.
