# Docs or spike ticket rubric

What a filled docs or spike ticket looks like, for whoever files it and for the intake agent that
checks it before the `ready` label counts. The type and its fields come from
[decision 176](../adr/0176-a-ticket-has-a-type-and-only-some-types-need.md); the form is
`.github/ISSUE_TEMPLATE/docs-spike.yml`. It needs no design unless a trigger of that decision
fires; then the design is a note on the ticket in the shape of
[the design note template](design-note.md).

## Required fields

- **Kind**: docs or spike.
- **What changes, or the question**: for docs, the claim or section that changes and why; for a
  spike, the one question it answers, asked so that an answer closes it.
- **Time box**: the most effort to spend before stopping and reporting, as a number and a unit:
  hours or session turns.
- **Form of the answer**: for docs, the page or pages that hold the change; for a spike, the file
  and its shape. Spike reports live under `docs/spikes/`.

## Optional fields

- **Estimate**: the source lines the change is expected to touch. Over 600, the cap of
  [decision 173](../adr/0173-the-diff-size-and-complexity-caps-are-hard-and.md), forces a design.
- **Dependency**: ticked when the change adds a dependency; it forces a design.

## A testable criterion

The change or the question is the hardest field. A docs ticket is done when a reader can check the
named page says the new thing. A spike is done when its file answers the question in the promised
shape, inside the time box, even if the answer is "no" or "not yet".

- Testable (docs): "`docs/02-cli.md` documents `pup session ask --option` and its exit codes."
- Testable (spike): "Can workers run in a container without losing hooks? Answer in
  `docs/spikes/<date>-container-worker.md`: yes or no, the blocker if no, and the cost if yes."
- Not testable: "Improve the CLI docs." "Look into containers."

## A scope boundary

The time box is the spike's boundary: at the end of it the spike reports what it has. For docs, the
named pages are the boundary.

- Bounded: "2 hours; stop and write up what is known."
- Bounded: "Only `docs/02-cli.md`; the onboarding guide is a separate ticket."
- Unbounded: "Until we know." "All docs that mention sessions."

## What makes a field vague

Intake comments on and removes `ready` for any field that:

- asks several questions, or one with no answer that would close it: "how should we do X?";
- names no page for a docs change: "update the docs";
- gives no unit or no number for the time box: "short", "a bit";
- gives no shape for the answer: "some notes", "findings";
- is a placeholder: "TBD", "n/a", "-", or the form's example left in;
- is one word where the field asks for a sentence, or holds an empty list item.

`bash scripts/ticket-check.sh docs <body-file>` (or `spike`) runs the mechanical part of this
check, missing fields, placeholders, one-word answers and empty list items, before filing. The rest
is the intake agent's reading.
