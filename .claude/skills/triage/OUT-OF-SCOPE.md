# Out-of-scope records

`docs/out-of-scope/` holds one file per rejected **concept**, not per issue: why a request was rejected, so the reasoning outlives the closed issue, and so a new issue that matches can be answered from it. Several issues asking for the same thing share one file.

## File

`docs/out-of-scope/<concept>.md`, a short kebab-case name recognisable without opening it (`dark-mode.md`). Write it like a short design note: a title, a paragraph on why, and the issues that asked.

```markdown
# <Concept>

<The decision, in one sentence.>

## Why this is out of scope

<The reason, with the constraint or decision it rests on: a project boundary, a technical constraint, a decision in docs/adr/. A durable reason, not "we are busy": that is a deferral, not a rejection.>

## Prior requests

- #42: "<title>"
```

## When to read it

At step 3 of triage, read every file. Match by concept: "night theme" matches `dark-mode.md`. On a match, surface it to the operator with its reason and ask whether they still agree. They may confirm (append the issue to Prior requests, then close), reconsider (delete or update the file, and the issue goes through normal triage) or disagree (related but distinct).

## When to write it

Only when an **enhancement** is rejected, never a bug and never a request closed as already built: a built feature recorded here would poison later matches. If a file for the concept exists, append the issue; otherwise create it. Then comment on the issue, naming the file, and close it.

If the operator reverses a rejection, delete the file. Old issues stay closed as history.
