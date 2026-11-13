# 0183. A rework step's setting is a store file read at compile time (2026-11-11)

- Status: accepted
- Amends: [0178](0178-each-rework-step-ships-behind-a-project-setting-and.md)

183. **A rework step's setting is a store file read at compile time (2026-11-11).**
    *The setting.* A rework step of decision 178 is on for a project while
    `~/.pupitre/<project-id>/rework/<step>` holds `on`. A missing file, a symlink, a file that
    is not regular, or any other content reads as off, the default. The first step is
    `shift-left-kickoff`. No command writes the file yet: the operator writes it by hand.
    *Why a file, not a column.* It follows `conductor/max-sessions` and the brief (decision 57):
    the compiler reads it itself, so every launch path picks it up by the same rule, with no
    migration and no caller change. A setting the operator turns on for one ticket and off again
    is better served by a file than by a schema change.
    *Read at compile time.* Turning a step on reaches the next launch or fix round, never a window
    already running: a respawn resends the stored context and recompiles nothing. The kickoff it
    changes is hashed, so turning it on or off marks the live sessions' profiles stale, as a brief
    edit does. It changes no gate.
    *The shift-left kickoff.* When on, a worker's kickoff gains a "Reviewers will check" section
    below the session protocol: one checklist per correctness, docs and conventions reviewer and
    decision 174's failing-scenario rule. Each checklist is read at compile time from the
    reviewer's agent file in the main checkout (`.claude/agents/review-<name>.md`), never copied
    into pup. A checklist is the bold-led paragraphs above the file's first `##` heading, then the
    bullets under its `## Flag` heading, or that section's opening paragraph when it has none,
    each cut to its first sentence. A reviewer whose file is missing has no checklist.
    *Ceiling.* The store and the main checkout are both within a session's shell reach (decision
    46), so a session can turn the step on or rewrite a checklist for a later compile. That is why
    the section sits below every rule and is framed as the brief is (decision 57): each line
    describes what a reviewer checks, changes no task, scope or rule, and the document above wins
    where they differ. A one-sentence instruction can still get through; it gets no authority.
