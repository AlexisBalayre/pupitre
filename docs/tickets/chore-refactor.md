# Chore or refactor ticket rubric

What a filled chore or refactor ticket looks like, for whoever files it and for the intake agent
that checks it before the `ready` label counts. The type and its fields come from
[decision 176](../adr/0176-a-ticket-has-a-type-and-only-some-types-need.md); the form is
`.github/ISSUE_TEMPLATE/chore-refactor.yml`. It needs no design unless a trigger of that decision
fires: an ADR area, a crossed module boundary, a new dependency, or an estimate over a cap of
[decision 173](../adr/0173-the-diff-size-and-complexity-caps-are-hard-and.md). The design is then a
note on the ticket in the shape of [the design note template](design-note.md).

## Required fields

- **Kind**: chore or refactor.
- **Scope boundary**: where the change stops, naming the neighbour left as it is.
- **Proof that behavior is unchanged**: the checks that exist today, tests, commands or outputs,
  and pass before and after without edits.
- **Files in scope**: one path or glob per line; nothing outside them changes.

## Optional fields

- **Estimate**: the source lines the change is expected to touch. Over 600 forces a design.
- **Dependency**: ticked when the change adds a dependency; it forces a design.

## A testable criterion

The proof is the criterion, and the hardest field. It is testable when it names checks that exist
today and pass both before and after, unedited. A test the ticket rewrites proves nothing about
unchanged behavior.

- Testable: "`test/unit/core/plan-service.test.ts` passes without edits, and `pup status --json`
  is byte-identical on the fixture."
- Not testable: "No regressions; I tested it." "Tests pass." "Same behavior."

## A scope boundary

The boundary names the neighbour that stays put, and the file list makes it enforceable.

- Bounded: "Split `plan.service.ts` into two files; callers and exported names stay as they are."
- Bounded: files in scope of `src/core/plan.service.ts` and `src/core/plan-store.service.ts`.
- Unbounded: "Tidy up core." "Whatever files the rename touches." `src/**`.

## What makes a field vague

Intake comments on and removes `ready` for any field that:

- leaves the end open: "and related cleanup", "etc.", "where needed";
- lists a whole tree instead of files: `src/**`, "the adapters";
- offers a proof that is not a check: "careful review", "I tested it";
- cites a test that the ticket itself changes as its proof;
- hides a behavior change inside a chore: a renamed flag, a new default, a changed message;
- is a placeholder: "TBD", "n/a", "-", or the form's example left in;
- is one word where the field asks for a sentence, or holds an empty list item.

`bash scripts/ticket-check.sh chore <body-file>` (or `refactor`) runs the mechanical part of this
check, missing fields, placeholders, one-word answers and empty list items, before filing. The rest
is the intake agent's reading.
