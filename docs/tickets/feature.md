# Feature ticket rubric

What a filled feature ticket looks like, for whoever files it and for the intake agent that checks
it before the `ready` label counts. The type and its fields come from
[decision 176](../adr/0176-a-ticket-has-a-type-and-only-some-types-need.md); the form is
`.github/ISSUE_TEMPLATE/feature.yml`. A feature gets a design by default.

## Required fields

- **Goal**: the outcome, stated so a reader can tell when it is reached. One or two sentences.
- **Acceptance criteria**: one testable criterion per line, at most 20, each under 500 characters
  (the caps of [decision 187](../adr/0187-a-task-carries-a-copy-of-its-ticket-and-the.md)).
- **Out of scope**: what the ticket will not do, though a reader might expect it to.
- **Affected area**: the modules, commands or paths the change lands in, and any decision it
  touches.

## A testable criterion

A criterion names an input or starting state, an action, and a result someone can observe: an exit
code, an output line, a file on disk, a refusal. A test could assert it without asking the author.

- Testable: "`pup plan add` with no `--scope` exits 2 and prints `scope is required`."
- Testable: "A task whose ticket lacks `design-approved` is refused at launch, naming the task."
- Not testable: "Planning is easier." "Errors are clearer." "Works with large repos."

## A scope boundary

The out-of-scope field draws the line a reader would otherwise guess at. It names the neighbouring
behavior that stays as it is.

- Bounded: "No change to `pup plan edit`; it keeps accepting tasks without a scope."
- Bounded: "The Python adapter is not covered; it gets its own ticket."
- Unbounded: "Nothing else." "TBD." "Keep it small."

## What makes a field vague

Intake comments on and removes `ready` for any field that:

- uses a word with no measure: "better", "faster", "cleaner", "robust", "as needed";
- states a wish instead of a result: "should handle errors properly";
- points elsewhere instead of saying it: "see Slack", "as discussed";
- is a placeholder: "TBD", "n/a", "-", or the form's example left in;
- names no place: an affected area of "core" or "the CLI" with no module or command;
- bundles several criteria in one line joined by "and", so one can pass while another fails.
