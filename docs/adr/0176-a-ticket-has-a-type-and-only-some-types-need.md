# 0176. A ticket has a type, only some types need a design, and the operator's label starts the work (2026-11-11)

- Status: accepted
- Amends: [0099](0099-workers-share-files-and-collaborate-a-launch-overlapping.md)

176. **A ticket has a type, only some types need a design, and the operator's label starts the work (2026-11-11).**
    *Intake.* GitHub Issues are the tracker, behind a narrow tracker interface so another tracker
    can follow. Issue forms in the repo give each type its fields, with a rubric per type under
    `docs/`. Only an issue carrying `ready`, applied by the operator or a collaborator with write
    access, is read. An intake agent checks the required fields before the label counts. On a
    failed check it comments which fields are missing or vague and removes the label. Issue text
    reaches a prompt as quoted data, never as instructions.
    *Types and their required fields.*
    - Feature: goal, testable acceptance criteria, out of scope, affected area.
    - Bug: reproduction, expected against actual, suspected area. The reproduction becomes a failing
      test before any code changes.
    - Chore or refactor: scope boundary, proof that behavior is unchanged, files in scope.
    - Docs or spike: what changes, or the question, the time box and the form of the answer.
    - Follow-up: source PR, findings, scenarios, original reviewers. The factory files one per merged
      PR, listing every minor, pre-existing and declined finding.
    *When a design is needed.* A feature has a design by default and the other types do not.
    A design is forced on any type that touches an ADR area, crosses a module boundary, adds a
    dependency, or whose estimate exceeds a cap of decision 173. A ticket under about 100 lines that
    triggers none goes straight to one slice, with no design review and no design validation.
    *The design.* A note in the ticket, with the slice list: each slice's files, estimated size and
    dependencies. Slices whose files overlap get a dependency edge, so one merges before the other
    starts. Agents review the design, and the operator validates it once per ticket by adding
    `design-approved`. This replaces decision 99's rule for factory slices that a launch overlapping
    a live session is never refused: the overlap is ordered at design time.
    *Sessions.* One fresh session per slice, never steered after its PR merges. A fix runs in a new
    short session. A stuck or failed slice restarts once with the failure summary, and a second
    failure pauses the ticket in the operator's queue.
