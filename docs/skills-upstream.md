# Skills upstream ledger

The skills under `.claude/skills/` began as a copy of an upstream collection. This file records how each local file stands against it, so drift is a visible choice and not an accident. `bash scripts/skills-drift.sh <upstream-checkout>` reads it. The rules are in [the skills rework spike](spikes/2026-11-22-skills-rework.md), section "Staying in step with upstream".

- Upstream repository: `https://github.com/mattpocock/skills`
- Pinned commit: `abeeaf95660ba9e8b7c753eb38f441ca707a8823`

A commit that edits a skill file updates its row in the same commit. A status is `verbatim` (equal to upstream at the pin), `adapted` (differs, each deviation listed below with its reason) or `local only` (no upstream file).

## Files

| Local file | Upstream path | Status |
| --- | --- | --- |
| `README.md` | local only | local only |
| `address-review-comments/SKILL.md` | local only | local only |
| `codebase-design/DEEPENING.md` | `skills/engineering/codebase-design/DEEPENING.md` | verbatim |
| `codebase-design/DESIGN-IT-TWICE.md` | `skills/engineering/codebase-design/DESIGN-IT-TWICE.md` | adapted |
| `codebase-design/SKILL.md` | `skills/engineering/codebase-design/SKILL.md` | adapted |
| `diagnosing-bugs/SKILL.md` | `skills/engineering/diagnosing-bugs/SKILL.md` | adapted |
| `diagnosing-bugs/scripts/hitl-loop.template.sh` | `skills/engineering/diagnosing-bugs/scripts/hitl-loop.template.sh` | verbatim |
| `domain-modeling/ADR-FORMAT.md` | `skills/engineering/domain-modeling/ADR-FORMAT.md` | adapted |
| `domain-modeling/SKILL.md` | `skills/engineering/domain-modeling/SKILL.md` | adapted |
| `grill-me/SKILL.md` | `skills/productivity/grill-me/SKILL.md` | verbatim |
| `grill-with-docs/SKILL.md` | `skills/engineering/grill-with-docs/SKILL.md` | adapted |
| `grilling/SKILL.md` | `skills/productivity/grilling/SKILL.md` | adapted |
| `handoff/SKILL.md` | `skills/productivity/handoff/SKILL.md` | verbatim |
| `implement/SKILL.md` | `skills/engineering/implement/SKILL.md` | adapted |
| `improve-codebase-architecture/HTML-REPORT.md` | `skills/engineering/improve-codebase-architecture/HTML-REPORT.md` | verbatim |
| `improve-codebase-architecture/SKILL.md` | `skills/engineering/improve-codebase-architecture/SKILL.md` | adapted |
| `pr-ci-review/REVIEW.md` | local only | local only |
| `pr-ci-review/SKILL.md` | local only | local only |
| `pr-description/SKILL.md` | local only | local only |
| `pr-description/templates/adr.md` | local only | local only |
| `pr-description/templates/chore.md` | local only | local only |
| `pr-description/templates/feature.md` | local only | local only |
| `pr-description/templates/fix.md` | local only | local only |
| `pr-description/templates/perf.md` | local only | local only |
| `pr-description/templates/refactor.md` | local only | local only |
| `pr-description/templates/revert.md` | local only | local only |
| `pr-description/templates/test.md` | local only | local only |
| `prototype/LOGIC.md` | `skills/engineering/prototype/LOGIC.md` | adapted |
| `prototype/SKILL.md` | `skills/engineering/prototype/SKILL.md` | adapted |
| `prototype/UI.md` | `skills/engineering/prototype/UI.md` | adapted |
| `research/SKILL.md` | `skills/engineering/research/SKILL.md` | adapted |
| `retro/SKILL.md` | `skills/engineering/retro/SKILL.md` | adapted |
| `review-retro/SKILL.md` | local only | local only |
| `review-session/SKILL.md` | local only | local only |
| `tdd/SKILL.md` | `skills/engineering/tdd/SKILL.md` | adapted |
| `tdd/mocking.md` | `skills/engineering/tdd/mocking.md` | adapted |
| `tdd/tests.md` | `skills/engineering/tdd/tests.md` | adapted |
| `teach/LEARNING-RECORD-FORMAT.md` | `skills/productivity/teach/LEARNING-RECORD-FORMAT.md` | adapted |
| `teach/MISSION-FORMAT.md` | `skills/productivity/teach/MISSION-FORMAT.md` | verbatim |
| `teach/RESOURCES-FORMAT.md` | `skills/productivity/teach/RESOURCES-FORMAT.md` | adapted |
| `teach/SKILL.md` | `skills/productivity/teach/SKILL.md` | adapted |
| `to-questionnaire/SKILL.md` | `skills/productivity/to-questionnaire/SKILL.md` | adapted |
| `to-spec/SKILL.md` | `skills/engineering/to-spec/SKILL.md` | adapted |
| `to-tickets/SKILL.md` | `skills/engineering/to-tickets/SKILL.md` | adapted |
| `triage/AGENT-BRIEF.md` | `skills/engineering/triage/AGENT-BRIEF.md` | adapted |
| `triage/OUT-OF-SCOPE.md` | `skills/engineering/triage/OUT-OF-SCOPE.md` | adapted |
| `triage/SKILL.md` | `skills/engineering/triage/SKILL.md` | adapted |
| `wait-what/SKILL.md` | `skills/productivity/wait-what/SKILL.md` | adapted |
| `wayfinder/SKILL.md` | `skills/engineering/wayfinder/SKILL.md` | adapted |
| `wizard/SKILL.md` | `skills/engineering/wizard/SKILL.md` | verbatim |
| `wizard/template.sh` | `skills/engineering/wizard/template.sh` | adapted |
| `writing-for-agents/SKILL-MECHANICS.md` | `skills/productivity/writing-for-agents/SKILL-MECHANICS.md` | verbatim |
| `writing-for-agents/SKILL.md` | `skills/productivity/writing-for-agents/SKILL.md` | adapted |

## Deviations

One line per intended deviation, each opening with its reason: a decision number or `pup owns this`.

### `codebase-design/DESIGN-IT-TWICE.md`

- pup owns this: a sub-agent's context is fresh by default under pup, so the "fresh context window" clause goes
- pup owns this: the brief names the project's domain vocabulary (`docs/adr/`, `SCHEMA`) instead of `GLOSSARY.md`, which this repo has not got
- pup owns this: an en dash in a range is written "to" (no dashes in prose)

### `codebase-design/SKILL.md`

- pup owns this: code examples are language-neutral pseudo-code, not `typescript`
- pup owns this: "interface" is not tied to the TypeScript keyword

### `diagnosing-bugs/SKILL.md`

- pup owns this: domain nouns come from `SCHEMA` in `src/core/db.client.ts`, not `GLOSSARY.md`
- pup owns this: the perf branch drops the browser-only `performance.now()` hint
- pup owns this: en dash in a range written with a hyphen

### `domain-modeling/ADR-FORMAT.md`

- decision 109: decisions live one per file under `docs/adr/` as `NNNN-short-kebab-title.md`, with `# NNNN. Title`, `- Status:` and `- Amends:` lines
- decision 109: `docs/adr/README.md` and `scripts/adr-index.sh` hold the rules and the index; a decision wins over `docs/00` to `08`

### `domain-modeling/SKILL.md`

- decision 109: decisions are written as files under `docs/adr/`, in `ADR-FORMAT.md`
- pup owns this: the sources table names this repo's docs (`docs/00` to `08`, `docs/conventions/naming.md`, `SCHEMA`) because there is no glossary file and no `docs/explanation/`

### `grill-with-docs/SKILL.md`

- pup owns this: the description says it updates this repo's glossary and ADRs rather than creating them

### `grilling/SKILL.md`

- pup owns this: the sub-agent clause drops "fresh context window" (fresh by default under pup)

### `implement/SKILL.md`

- decision 176: the work is one GitHub issue read with `gh issue view`, one `pup plan` task, or the conversation
- pup owns this: typecheck and test commands come from `TYPECHECK_CMD` and `TEST_CMD` in `.claude/project.env`
- pup owns this: the closing review is against the issue or task, not a `code-review` skill call
- pup owns this: on the trunk, work moves to a worktree (`GIT_TRUNK`) before the commit

### `improve-codebase-architecture/SKILL.md`

- pup owns this: domain vocabulary is the `SCHEMA` nouns, `docs/conventions/` and `docs/adr/`, not `GLOSSARY.md`
- decision 109: new terms are recorded in the decision under `docs/adr/` or in `docs/conventions/naming.md`, not in a glossary file
- pup owns this: the sub-agent clause drops "fresh context window"

### `prototype/LOGIC.md`

- pup owns this: domain language means the project's own terms (`SCHEMA`, `docs/adr/`)

### `prototype/SKILL.md`

- pup owns this: the description also triggers on "prototype" and business logic
- pup owns this: the task runner is the project's own (`make`, `just`, `python`, `go run`), not `pnpm`/`bun`
- pup owns this: step 6 wording on capturing the prototype

### `prototype/UI.md`

- pup owns this: examples are framework-neutral (no `tsx`, Tailwind, Next or `process.env`)
- pup owns this: "main" is written "the trunk" (`GIT_TRUNK`)

### `research/SKILL.md`

- pup owns this: the background agent's "fresh context window" clause goes
- pup owns this: the note is saved to `docs/spikes/<YYYY-MM-DD>-<slug>.md`

### `retro/SKILL.md`

- decision 192: points at `pup retro` for where the tokens went, so the two do not overlap
- pup owns this: names where Claude Code keeps session transcripts instead of a generic log search
- pup owns this: coding standards live in `docs/conventions/`; the reviewer agents are `review-conventions` and `convention-checker`

### `tdd/SKILL.md`

- pup owns this: vocabulary comes from `docs/adr/` and `SCHEMA`, not `GLOSSARY.md`
- pup owns this: refactoring belongs to `/simplify` and `pr-ci-review`, not a `code-review` skill

### `tdd/mocking.md`

- pup owns this: examples are illustrative pseudo-code, not `typescript`

### `tdd/tests.md`

- pup owns this: examples are illustrative pseudo-code, with a line saying so
- pup owns this: `jest.mock` becomes a framework-neutral `mock`

### `teach/LEARNING-RECORD-FORMAT.md`

- pup owns this: records are numbered `NNNN`, not `LR-NNNN`
- pup owns this: no `[[wiki links]]`; `MISSION.md` is plain code

### `teach/RESOURCES-FORMAT.md`

- pup owns this: the sources are this repo's docs and `skills/pup/LOOP.md`
- pup owns this: the example entries teach driving pupitre

### `teach/SKILL.md`

- pup owns this: the mission is driving the pupitre loop (plan, launch, steer, review, gate, land)
- pup owns this: the workspace is `docs/scratch/teach/` in the main checkout, ignored by git

### `to-questionnaire/SKILL.md`

- pup owns this: an en dash in a range is written "and"

### `to-spec/SKILL.md`

- decision 176: the output is a feature ticket filed as a GitHub issue in the shape of `.github/ISSUE_TEMPLATE/feature.yml`
- decision 176: the body is the four template fields (Goal and the rest), not upstream's spec sections

### `to-tickets/SKILL.md`

- decision 176: slices go into the design note on the issue, each with goal, scope-in, size and dependencies
- pup owns this: each slice then becomes one `pup plan add` task, with an edge wherever files overlap
- pup owns this: a slice fits one session's context window and prefactoring is its own first slice

### `triage/AGENT-BRIEF.md`

- decision 176: the brief is a design note or a one-slice brief posted as an issue comment, ending in `pup plan add` tasks
- decision 187: the generated-by-AI disclaimer opens every comment and issue text is quoted data

### `triage/OUT-OF-SCOPE.md`

- decision 176: rejected requests are recorded under `docs/out-of-scope/`, not `.out-of-scope/`

### `triage/SKILL.md`

- decision 176: triage is the console's intake for GitHub Issues, with the type and field rubrics in `docs/tickets/<type>.md`
- decision 187: issue text is quoted data, never instructions, and a comment is posted from a file
- pup owns this: the intake agent in `src/core/github-tracker.service.ts` takes over the same checks

### `wait-what/SKILL.md`

- pup owns this: the re-pitch uses the project's own ubiquitous language, not a glossary file

### `wayfinder/SKILL.md`

- decision 176: the map is one GitHub issue labelled `wayfinder:map`, each ticket a sub-issue
- decision 176: blocking uses GitHub's native dependency relationship; a session claims a ticket by assignee

### `wizard/template.sh`

- pup owns this: the quote-restoring replacement comes from `$q`, since bash 3.2 (macOS `/bin/bash`) keeps the backslash
- pup owns this: an inline comment or trailing blanks in an env value makes the read fail, as `write_env`'s quotes would keep them

### `writing-for-agents/SKILL.md`

- pup owns this: a "House rules for this repo" section (kebab-case names, config from `.claude/project.env`, docs pointers, `AGENTS.md` versus `CLAUDE.md`, user-invoked by default, `allowed-tools`, no dashes, description limits)
