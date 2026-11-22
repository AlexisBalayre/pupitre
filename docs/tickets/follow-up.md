# Follow-up ticket rubric

What a filled follow-up ticket looks like, for whoever files it and for the intake agent that checks
it before the `ready` label counts. The type and its fields come from
[decision 176](../adr/0176-a-ticket-has-a-type-and-only-some-types-need.md); the form is
`.github/ISSUE_TEMPLATE/follow-up.yml`. The factory files one per merged PR, listing every minor,
pre-existing and declined finding of its review. It needs no design unless a trigger of that
decision fires.

## Required fields

- **Source PR**: the merged PR the findings come from, as `#NNN`.
- **Findings**: every minor, pre-existing and declined finding, one per line, each tagged with its
  kind and the file and line it points at.
- **Scenarios**: for each finding, the input or sequence that shows it, and what should happen
  instead.
- **Original reviewers**: who reviewed the source PR, human or agent.

## A testable criterion

A scenario is the criterion for its finding. It is testable when a test can drive the input and
assert the result the finding asks for.

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
- is a placeholder: "TBD", "n/a", "-", or the form's example left in.
