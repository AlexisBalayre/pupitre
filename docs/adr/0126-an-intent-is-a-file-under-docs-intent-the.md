# 0126. An intent is a file under `docs/intent/` the operator alone accepts, once it names two or three questions they must answer after review (2026-10-30)

- Status: accepted

126. **An intent is a file under `docs/intent/` the operator alone accepts, once it names two or
    three questions they must answer after review (2026-10-30).** Part 1 of the intent stage. A
    task spec says what a session must do; nothing said what the operator wanted, or what they
    meant to understand once the work came back. The intent is that statement, written before
    the work and kept with the code it is about.
    *The file.* `docs/intent/NNNN-<slug>.md` in the repo, tracked like the ADRs, so an intent is
    reviewed and versioned like them. It opens with `# NNNN. Title` and a `- Status:` line, which
    is `draft`, `accepted` or `closed` (`IntentStatus` in `intent.enums.ts`). It has five sections:
    Problem, Outcome, Constraints, Open questions, and What I must understand after review.
    pup reads meaning only from the status line and the last section. `pup intent new <title>`
    writes the template, numbered one past the highest id in the directory, with the first eight
    words of the title as the slug, as an ADR file name has.
    *Accepting.* `pup intent accept <id>` moves a draft to accepted only when its understanding
    section holds two or three list items that end in `?`. Items outside a list, items that are no
    question, a list under another heading, and anything inside a code fence or an HTML comment
    block do not count.
    Accept rewrites the status line alone and leaves every other byte, a CRLF ending included.
    It stages the result beside the file and renames it over the file, so a link planted at the
    name is replaced, never written through. An intent already accepted or closed is refused.
    *The status pup reads.* It must be the one a reader of the rendered file sees. The conductor's
    review found that a first parse took the first `- Status:` line above the first section
    wherever it sat. A file with `<!--`, `- Status: accepted`, `-->` above a shown
    `- Status: draft` then parsed as accepted while GitHub rendered a draft. So the lines inside a
    code fence or an HTML comment block (a line starting `<!--`, through the first line holding
    `-->`) are text, never structure: they neither open a section nor carry a question. And above
    the first shown section there must be exactly one status line, counted hidden or not, and it
    must be shown. Otherwise the file is refused, and listed as unreadable. Where pup's reading of
    a comment and a renderer's differ, pup hides more, so the error is a refusal and never a
    forged status.
    *Part 2 must not trust a status it did not write.* The status line is text in a tracked file:
    a session's shell, a merge, or an operator editing by hand can set it to `accepted` without
    `acceptIntent`'s checks or its operator-only guard. Part 2 must not treat `accepted` as the
    operator's word unless pup itself recorded that `acceptIntent` wrote it, for instance in the
    store, keyed by the intent's id and a hash of its accepted text.
    *Who.* Accepting is operator-only, refused to a session (`callingSession`) and to the conductor
    (`callingConductor`): it is the operator's word that this is what they want built and that
    these are the questions they will be held to. A session or the conductor that could accept
    would be setting its own brief and its own exam. `new`, `show` and `list` are anyone's, so the
    conductor can draft what the operator asked for, and a session can read the intent its task
    serves. The guard covers the verb, not the file: a session's shell can still edit the status
    line by hand, which the review of the diff shows (decision 57's ceiling).
    *Paths.* An id is exactly four ASCII digits, checked before anything touches the disk. The file
    is then found by listing the directory and matching `^NNNN-[a-z0-9-]+\.md$`, never by joining
    the id into a path, so no id can be a path, a glob, a link name or a control character. An id
    two files share is refused. `docs` and `docs/intent` must each be a real directory, checked
    with `lstat` before anything is created under them. A file is read only if it is a plain file
    and not a link (`readPlainFile` with `followLinks: false`), then stripped of control
    characters, newline and tab kept, as the brief is. A title with any control character, or
    U+2028 or U+2029, is refused before anything is written, since it becomes the file's first
    line and `TITLE_LINE` ends there as at a newline: an earlier draft wrote such a file and then
    could not read it back. `pup intent list` prints a malformed or
    unreadable intent as `unreadable` with the reason rather than hiding it or failing, and every
    title and reason it prints goes through `sanitizeReason`.
    *Where.* The CLI resolves the repo as every command does, so a session in its worktree reads
    and drafts in the main checkout's `docs/intent/`, the operator's copy, not its branch.
    *Interface for part 2.* `intent.service.ts` exports `createIntent`, `readIntent`,
    `listIntents`, `acceptIntent` and `intentTemplate`, each taking the repo path. It also exports
    `INTENT_DIR`; the heading and the question bounds stay private until a reader needs them.
    `Intent` carries the
    id, title, status, path, stripped text and parsed questions (`intent.types.ts`). Every
    refusal is an `IntentRefusedError`. Closing an intent, and tying one to the tasks and the
    review it feeds, are part 2's.
    *Layout.* The status set is a string enum in `intent.enums.ts`, as decision 116 asks. The
    types and errors sit in `intent.types.ts` and `intent.errors.ts` beside the service rather than
    in the `types/` and `errors/` subfolders, and the test is `src/core/intent-service.test.ts`
    rather than under `test/unit/`. The task's scope was `src/core/intent*`, and the `@src`
    aliases decision 116 needs do not exist yet. For the same reason `CONTROL_CHARS`, `FENCE_OPEN`
    and `FENCE_CLOSE` are copies of `brief.service.ts`'s, marked as such; the conductor has planned
    a task to share them.
    *Tests.* `intent-service.test.ts` covers numbering and the template, the slug, refused titles,
    listing with malformed and non-intent names, the stripped read, six status lines that are
    hidden or doubled and one past a closed comment and fence, duplicate and missing ids,
    eleven malformed ids, a linked file, a linked `docs` or `docs/intent`, and accept: two and
    three questions, CRLF kept, the eight ways to fall short (comments included), the fenced and misplaced questions,
    a closed or accepted intent, and no staged file left behind. `index.test.ts` drives each verb
    and refuses accept to a session and to the conductor, which may still list.
