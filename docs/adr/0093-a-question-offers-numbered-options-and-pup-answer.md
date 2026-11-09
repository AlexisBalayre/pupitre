# 0093. A question offers numbered options with a recommendation, the conductor asks with `pup conductor ask`, and `pup answer` takes one keystroke (2026-11-09, amends decision 76)

- Status: accepted
- Amends: [0076](0076-a-blocked-worker-asks-with-pup-session-ask.md)

93. **A question offers numbered options with a recommendation, the conductor asks with `pup
    conductor ask`, and `pup answer` takes one keystroke (2026-11-09, amends decision 76).**
    Decision 76 put a worker's question in the store, but answering it still meant reading prose,
    writing prose back, and typing `pup steer <id> "..."` around it. The conductor had no such
    command: a decision only the operator could take (a gate flag, a steer past its budget, a
    change of scope) was written as prose in its pane, which nobody reads until they attach.

    *The structured ask.* `pup session ask "<question>"` takes `--option <text>` (up to four, one
    key each) and `--recommend <n>` (the 1-based option the asker would pick). The `question`
    event stores `{text, options?, recommended?}`. The CLI refuses more than four options, a blank
    option, and a `--recommend` that names no option, and records nothing when it does. The
    worker's protocol line keeps decision 76's sentence and adds one: when the answer is a choice,
    always offer it as options with your recommendation.

    *The conductor asks too.* `pup conductor ask "<question>" --option … --recommend n` is the
    conductor's alone: it is refused to the operator, to a session, and to a `PUP_CONDUCTOR`
    naming another project. Through `markConductorQuestion` it appends the same `question` event
    held against no session (`session_id` NULL). The conductor's kickoff gains a "Questions for the
    operator" section, typed in after the CI review loop. It orders every operator decision (gate
    flags, steers beyond its budget, scope changes) through `pup conductor ask` rather than prose
    in its pane, and then an end to its turn. One question at a time: the newest replaces the open
    one.

    *Answering.* `pup answer <session|conductor> <n|text>` is operator-only, refused to a session
    and to the conductor, since either would be deciding in the operator's name. A bare number
    picks that option of a question that offers some. A number past the options is refused with
    nothing typed: it is a slip, not an answer. Any other text, and any reply to a question asked in
    words alone, is a free answer. The answer is delivered prefixed by the question it answers
    (`Answer to your question "<q>": option 2, <text>`), so a late answer is never a riddle. For a
    session it goes through `steerSession` (kind `answer`, by `operator`), with that function's
    refusals. For the conductor it goes as a `pup conductor tell`, with the tell's refusals and its
    800-character limit. An `answer` event `{question, text, option?}` is recorded only once the
    paste landed. A tell that did not land leaves the question open and says so.

    *Open questions are read in one place.* `openQuestion(db, sessionId | null)` in the session
    repository is the newest of a row's `question`, `steer` and `answer` events, when that is a
    `question`, with its options cut to four. A session's question still closes on any steer
    (decision 76) and now on an answer too. The conductor's closes only on an answer, since no
    steer reaches it. The dashboard, `pup answer` and the TUI all read through it, so the inbox's
    numbers and the answer's cannot disagree. The payload is session-writable, so the dashboard
    scrubs the text and every option with `sanitizeReason` (decision 29) and drops a recommendation
    that names no option. The inbox also swaps arrows and emoji for `-`, as it already did for the
    text. A session's question is shown only while it runs, the conductor's only while its window
    is up.

    *Where it shows (closing decision 76's "not changed here").* An open question sets `needsHuman`
    and sorts the row first in `pup status` and in the TUI, above blocked and stalled rows: it
    idles a worker that has said exactly what it needs. In the needs-you inbox the conductor's
    question leads, then the sessions' questions, then the rest in decision 83's order. Each
    question line answers with `pup answer <id> <n>, or pup answer <id> "..."`, and its options
    follow it numbered, the recommended one marked `(recommended)`, through `needLines` in both
    `pup status` and the fleet view. In `pup ui` the detail pane lists the options the same way,
    and the number keys 1–9 answer the selected session's open question through `answerSelected`,
    the same core function `pup answer` calls. A question with no options takes words, which `s`
    sends. The web overview prints the question's text as before; its numbered options are left to
    the text surfaces.
