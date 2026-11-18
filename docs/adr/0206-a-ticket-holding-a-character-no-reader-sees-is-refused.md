# 0206. A ticket holding a character no reader sees is refused (2026-11-18)

- Status: accepted
- Amends: [0187](0187-a-task-carries-a-copy-of-its-ticket-and-the.md)

206. **A ticket holding a character no reader sees is refused (2026-11-18).**
    A ticket's text is anyone's who files an issue, and decision 187 copies it into every
    kickoff of its slices and prints its criteria in `pup review`. The kickoff's `quoted` and
    review's `sanitizeReason` drop only C0 and C1 controls, so a bidi override, a zero-width
    character, U+FEFF or a tag character (U+E0000–E007F, which spells out text no one sees) reached
    the session and the reviewer's terminal unseen.
    *Refused, at the one check.* `assertTicketBounds` refuses a ticket whose type, design note,
    labels, triggers or criteria hold a format character (`\p{Cf}`) or a default-ignorable code
    point, naming each field and its first such character as `U+XXXX`. It is the class
    `FORMAT_CHARS` strips from a fix round's threads. Every reader of a stored ticket goes through
    the check: `pup plan add`, `readTaskSpec` for launch, the gate and review, and now every
    compile, whose `validateInput` calls `assertPlannableSpec` instead of repeating its scope
    checks, so a kickoff cannot carry what the store would refuse.
    *Rejected: stripping.* The text a session then reads would differ from the text the operator
    approved on the tracker, which decision 187's refusal of over-cap text already declines to do.
    The cost is that an emoji built with a joiner or a variation selector is refused too: the
    operator removes it from the issue and writes the ticket again.
    *An edit does not re-check the ticket.* `pup plan edit` copies the stored ticket and never
    changes it, so `editTaskSpec` validates the edited spec without it. A row whose ticket fails
    this or any later check can still have its goal, scope or acceptance repaired; launch, the
    gate and review still refuse it.
    *Review prints a criterion whole.* A criterion may hold 500 characters and `sanitizeReason`
    cuts at 300, so `pup review` prints a longer one on continuation lines, broken at a space
    where one falls within 300 characters, with nothing dropped.
    *Tests.* `task-spec.test.ts` for each character class and field;
    `profile-compiler-ticket.test.ts` for a compile refusing them; `index.test.ts` for a review
    that refuses one and one that prints a 494-character criterion whole;
    `session-repository.test.ts` for an edit past a ticket that fails a check.
