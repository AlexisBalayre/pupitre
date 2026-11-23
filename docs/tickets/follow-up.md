# Follow-up ticket rubric

What a filled follow-up ticket looks like, for whoever files it and for the intake agent that checks
it before the `ready` label counts. The type and its fields come from
[decision 176](../adr/0176-a-ticket-has-a-type-and-only-some-types-need.md); the form is
`.github/ISSUE_TEMPLATE/follow-up.yml`. The factory files one per merged PR, listing every minor,
pre-existing and declined finding of its review. It needs no design unless a trigger of that
decision fires; then the design is a note on the ticket in the shape of
[the design note template](design-note.md).

## Required fields

- **Source PR**: the merged PR the findings come from, as `#NNN`.
- **Findings**: every minor, pre-existing and declined finding, one per line, each tagged with its
  kind and the file and line it points at.
- **Scenarios**: for each finding, one line: the input or sequence that shows it, and what should
  happen instead.
- **Original reviewers**: each reviewer of the source PR by handle, human or agent.

## Optional fields

- **Estimate**: the source lines the fixes are expected to touch. Over 600, the cap of
  [decision 173](../adr/0173-the-diff-size-and-complexity-caps-are-hard-and.md), forces a design.
- **Dependency**: ticked when a fix adds a dependency; it forces a design.

## A testable criterion

A scenario is the criterion for its finding, and the hardest field. It is testable when a test can
drive the input and assert the result the finding asks for.

- Testable: "`pup plan add` with a scope of `../x` prints the task id in the refusal; today it
  prints only the path."
- Not testable: "Error messages could be better." "Edge cases in the scope parser."

## A scope boundary

The findings list is the boundary: the follow-up closes those findings and nothing else. A finding
the follow-up declines again is recorded as declined, with the reason, not dropped.

- Bounded: three findings, each with a file and line, each with a scenario.
- Unbounded: "Address review comments." "Plus anything else found on the way."

## What makes a field vague

Intake comments on and removes `ready` for any field that:

- names no PR, or one that is not merged;
- summarises findings instead of listing them: "a few nits";
- gives a finding no kind, file or line;
- leaves a finding without a scenario;
- names reviewers as a group: "the team", "the bots";
- is a placeholder: "TBD", "n/a", "-", or the form's example left in;
- is one word where the field asks for a sentence, or holds an empty list item.

`bash scripts/ticket-check.sh follow-up <body-file>` runs the mechanical part of this check,
missing fields, placeholders, one-word answers and empty list items, before filing. The rest is the
intake agent's reading.
