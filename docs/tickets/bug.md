# Bug ticket rubric

What a filled bug ticket looks like, for whoever files it and for the intake agent that checks it
before the `ready` label counts. The type and its fields come from
[decision 176](../adr/0176-a-ticket-has-a-type-and-only-some-types-need.md); the form is
`.github/ISSUE_TEMPLATE/bug.yml`. A bug needs no design unless a trigger of that decision fires;
then the design is a note on the ticket in the shape of [the design note template](design-note.md).
The reproduction becomes a failing test before any code changes, so write it for that test.

## Required fields

- **Reproduction**: numbered steps from a clean state, with the commit or version, every command
  and every input.
- **Expected against actual**: what should happen, and what happens instead, with the exact output
  or exit code.
- **Suspected area**: the file, module or command suspected, and why; with no lead, what was ruled
  out. A bare "unknown" is vague.

## Optional fields

- **Estimate**: the source lines the fix is expected to touch. Over 600, the cap of
  [decision 173](../adr/0173-the-diff-size-and-complexity-caps-are-hard-and.md), forces a design.
- **Dependency**: ticked when the fix adds a dependency; it forces a design.

## A reproduction

The hardest field. It is good when someone else, on a fresh checkout, can type the steps and see
the failure, and a test can do the same.

- Good: "1. On main at 9d2ae7b8, run `pup plan add t-1 --scope 'src/**'` 2. Run `pup launch t-1`."
- Vague: "Set up a session in my repo, then launch it; it fails sometimes."

## A testable criterion

For a bug, the criterion is the expected half of "expected against actual". It is testable when the
failing test can assert it as written: an exit code, an output line, a state on disk.

- Testable: "Expected: `pup launch t-1` starts the session. Actual: exits 1 with `scope collides
  with t-0`, though t-0 is merged."
- Not testable: "Expected: it works. Actual: it breaks."

## A scope boundary

A bug ticket fixes the reproduced case. Its boundary is the reproduction itself: the fix makes that
test pass and changes nothing the test does not need. A second symptom is a second ticket.

- Bounded: "Only the collision check at launch; `pup plan add` reports the same collision
  correctly."
- Unbounded: "Also clean up the collision code while there."

## What makes a field vague

Intake comments on and removes `ready` for any field that:

- has steps that only work on the author's machine: no commit, no input, "my repo";
- skips a step: "set up a session, then launch";
- says "sometimes" or "randomly" with no frequency or condition that raises it;
- gives the actual result as a feeling, not the output: "it hangs", "weird error";
- leaves expected unstated or circular: "it should not fail";
- is a placeholder: "TBD", "n/a", "unknown", "-", or the form's example left in;
- is one word where the field asks for a sentence, or holds an empty list item.

`bash scripts/ticket-check.sh bug <body-file>` runs the mechanical part of this check, missing
fields, placeholders, one-word answers and empty list items, before filing. The rest is the intake
agent's reading.
