# Skill catalog

Each skill is a `<name>/SKILL.md`. Claude sees only the one-line description at session start
and loads the full skill when it is relevant. This catalog says **when** each fires and **how**
to invoke it.

**Invoke legend**
- **Auto or `/name`** — Claude triggers on the cue described; you can also run `/name` yourself.
- **Auto (Claude-only)** — Claude triggers it; hidden from the `/` menu (`user-invocable: false`).
- **Manual only** — you invoke it; Claude never auto-triggers (`disable-model-invocation: true`).

## Intake & planning — from issue to planned tasks

The tracker is GitHub Issues (decision 176) and work runs as `pup plan` tasks. These skills take an
issue to tasks; the operator, not a skill, adds `ready` and `design-approved`.

| Skill | When to use | Invoke |
| :---- | :---------- | :----- |
| `to-spec` | Turn the current conversation into a feature ticket and file it as a GitHub issue with `gh issue create`: no interview, just synthesis of what was already discussed. | Manual only (`/to-spec`) |
| `to-tickets` | Break an approved ticket, plan or conversation into tracer-bullet slices with their dependency edges, then plan one pup task per slice and launch the free ones. | Manual only (`/to-tickets`) |
| `triage` | Take an issue from filed to ready to plan, or to rejected: check its type and fields, find duplicates and prior rejections, reproduce a bug, decide whether it needs a design, and propose its slices. Proposes only; never adds `ready` or `design-approved`. | Manual only (`/triage`) |
| `to-questionnaire` | A decision you can't answer alone: turn it into a questionnaire for the one person who can. | Manual only (`/to-questionnaire`) |
| `wayfinder` | Plan work too big for one agent session as a shared map of decision tickets (GitHub issues, sub-issues and native blocking), then resolve them one at a time; decisions that bind the codebase land in `docs/adr/`. | Manual only (`/wayfinder`) |
| `implement` | Implement one GitHub issue or `pup plan` task by hand: TDD, the project's typecheck/test commands, a self-review against the acceptance criteria, then commit on a feature branch. | Manual only (`/implement`) |

## Engineering — build, fix, and clean up

| Skill | When to use | Invoke |
| :---- | :---------- | :----- |
| `tdd` | Building a feature or fixing a bug test-first; "red-green-refactor"; want integration tests. Drives the red → green loop (refactoring belongs to the review stage, not the loop). | Auto or `/tdd` |
| `diagnosing-bugs` | A hard bug or performance regression; "diagnose/debug this"; something broken, throwing, failing, or slow. Builds a feedback loop first and redacts secrets from anything it shows. | Auto or `/diagnosing-bugs` |
| `wizard` | A step only a human can do (dashboard clicks, credentials, CI secrets, a one-off cutover): generates an interactive bash wizard that walks them through it. | Auto or `/wizard` |
| `research` | Research a question against primary sources and save the cited findings to `docs/spikes/<YYYY-MM-DD>-<slug>.md`. | Auto or `/research` |
| `improve-codebase-architecture` | "improve architecture" / "find refactors" / "make it more testable". Scans for deepening opportunities, presents a visual HTML report, then grills through whichever one you pick. | Manual only (`/improve-codebase-architecture`) |

## Thinking & design — get to clarity before coding

| Skill | When to use | Invoke |
| :---- | :---------- | :----- |
| `prototype` | Sanity-check a state model or logic, or explore a UI, before committing. Logic prototypes are one shareable HTML file; the prototype is kept on a throwaway branch as evidence. | Auto or `/prototype` |
| `grilling` | The shared grilling core: rounds of numbered questions, each with a recommended answer, until no open question remains. Facts come from the codebase, decisions from you. | Auto or `/grilling` |
| `grill-me` | Thin wrapper: a plain grilling session on your plan or design. | Manual only (`/grill-me`) |
| `grill-with-docs` | Thin wrapper: grilling plus `domain-modeling`, so the decisions under `docs/adr/` and the naming docs are updated as decisions land. | Manual only (`/grill-with-docs`) |
| `codebase-design` | Shared vocabulary for deep modules: interfaces, seams, testability, design-it-twice. Other skills call it. | Auto or `/codebase-design` |
| `domain-modeling` | Build and sharpen the domain model (`docs/adr/`, the `SCHEMA` nouns in `src/core/db.client.ts`, `docs/conventions/naming.md`) while discussing terminology or decisions. | Auto or `/domain-modeling` |

## PR & review — from branch to merged

| Skill | When to use | Invoke |
| :---- | :---------- | :----- |
| `pr-description` | Draft or rewrite a PR title and body from one of eight templates by PR kind (feature, fix, refactor, ADR, chore, test, perf, revert; Summary as a Mermaid diagram, before/after Evidence, Merge Danger), ending in `Closes #N` for a PR born from an issue. A pup session's PR body is written by pup itself. | Auto or `/pr-description` |
| `review-session` | Review a worker session's branch before the gate on a Standards axis and a Spec axis in two parallel subagents, and report a must-fix list for one `pup steer`. The console's; the conductor reviews by pinned commit. | Manual only (`/review-session`) |
| `pr-ci-review` | Cost-optimal multi-agent code review of local changes or a PR: relevance-gated `review-*` subagents, a validation pass, and a structured verdict. Under CI (`.github/workflows/claude-code-review.yml`, owner-triggered only) the poster in `tools/review/` renders it to the PR; the model has no write channel. | Manual only (`/pr-ci-review`), or CI on every PR |
| `address-review-comments` | Triage, decide, challenge, and implement a PR's open review threads end to end, replying as you go, with a human in the loop. | Auto or `/address-review-comments` |
| `review-retro` | Mine past automated-review runs for recurring process/judgment failures and propose evidence-cited fixes to the review setup as one PR. Needs CI-produced run history (see the skill's setup note). | Manual only (`/review-retro`) |

## Meta & workflow

| Skill | When to use | Invoke |
| :---- | :---------- | :----- |
| `writing-for-agents` | Create or edit a skill, `AGENTS.md`, or `CLAUDE.md` well: context pointers, information hierarchy, leading words, invocation mechanics, and this repo's house rules. | Auto or `/writing-for-agents` |
| `retro` | After a session: read its transcript and suggest fixes to the agent's environment (missing checks, conventions, navigation pointers, no-op instructions, costly tool calls), most severe first. | Manual only (`/retro`) |
| `handoff` | Compact the current conversation into a handoff document for another agent or a fresh session. | Manual only (`/handoff`) |
| `teach` | Learn to drive the pup loop (plan, launch, steer, review, gate, CI, fix, land, audit) in a gitignored workspace, practised on a scratch project. | Manual only (`/teach`) |
| `wait-what` | A message didn't land: the agent re-pitches it with context, plain language, and the project's own terms. | Manual only (`/wait-what`) |

The planning, engineering, thinking and meta skills track [mattpocock/skills](https://github.com/mattpocock/skills), adapted to this repo's docs layout (`docs/adr/`, `docs/conventions/`) and `.claude/project.env`. [`docs/skills-upstream.md`](../../docs/skills-upstream.md) records the pinned upstream commit and how each file here stands against it (verbatim, adapted or local only); `bash scripts/skills-drift.sh` checks it.
