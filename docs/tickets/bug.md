# Bug ticket rubric

What a filled bug ticket looks like, for whoever files it and for the intake agent that checks it
before the `ready` label counts. The type and its fields come from
[decision 176](../adr/0176-a-ticket-has-a-type-and-only-some-types-need.md); the form is
`.github/ISSUE_TEMPLATE/bug.yml`. A bug needs no design unless a trigger of that decision fires.
The reproduction becomes a failing test before any code changes, so write it for that test.

## Required fields

- **Reproduction**: exact steps from a clean state, with commands, inputs and the commit or
  version they ran on.
- **Expected against actual**: what should happen, and what happens instead, with the exact output
  or exit code.
- **Suspected area**: the file, module or command suspected, and why; or "unknown" with what was
  ruled out.

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
- is a placeholder: "TBD", "n/a", "-", or the form's example left in.
