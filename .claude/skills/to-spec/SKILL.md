---
name: to-spec
description: "Turn the current conversation into a feature ticket and file it as a GitHub issue: no interview, just synthesis of what you've already discussed."
disable-model-invocation: true
---

This skill takes the current conversation context and codebase understanding and files a **feature ticket**. Do NOT interview the user; just synthesize what you already know.

The ticket is a GitHub issue in the shape of `.github/ISSUE_TEMPLATE/feature.yml`, with the `feature` label. `docs/tickets/feature.md` says what a filled one looks like and what the intake check refuses as vague (decision 176): read it before you write the fields.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's own vocabulary (the `SCHEMA` nouns in `src/core/db.client.ts`, the decisions in `docs/adr/`) throughout the ticket, and respect the decisions in `docs/adr/` for the area you're touching; find them with `bash scripts/adr-index.sh`.

2. Sketch out the seams at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase, the better; the ideal number is one.

Check with the user that these seams match their expectations.

3. Write the four fields below, then file the issue (see Filing).

<fields>

### Goal

The outcome, stated so a reader can tell when it is reached, from the user's perspective. One or two sentences.

### Acceptance criteria

One testable criterion per line, at most 20, each under 500 characters. A criterion names a starting state, an action and a result someone can observe (an exit code, an output line, a file, a refusal). Put the testing decisions here: the seam each criterion is tested at, and the existing test it follows.

### Out of scope

The neighbouring behaviour that stays as it is, which a reader might expect to change.

### Affected area

The modules, commands or decisions the change lands in. Name modules and interfaces, not file paths or code snippets: they go stale fast.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it and note briefly that it came from a prototype. Trim to the decision-rich parts.

</fields>

## Filing

```sh
gh issue create --label feature --title "<outcome, short>" --body-file <file>
```

The body uses a `### Goal`, `### Acceptance criteria`, `### Out of scope` and `### Affected area` heading each, the way the issue form renders them. Write the body to a file outside the repo and pass it with `--body-file`; never splice it into the command line.

Never add `ready` or `design-approved`: the operator or a write-access collaborator adds `ready` once the ticket reads well, and the design review adds `design-approved`. Report the issue URL and stop; `/to-tickets` turns it into launched tasks once the design is approved.
