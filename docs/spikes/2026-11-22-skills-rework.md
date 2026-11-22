# Spike: rework the Claude Code skills around the pup loop (2026-11-22)

`.claude/skills/` was copied from an upstream skills collection and adapted
for a repo with no tracker and one decision log. Both facts are now false.
Decision 176 made GitHub Issues the tracker, and decision 109 split
`docs/09-decisions.md` into `docs/adr/`. Several skills also describe a
workflow that pup now runs itself. This spike re-derives the skill set from
how pupitre is driven, gives every entry a verdict, specifies three new
skills taken from upstream (triage, code-review, teach), lists every stale
pointer, sets the rule that keeps local copies in step with upstream, and ends
with the implementation tasks. No skill is changed here.

**Verdict: of the 30 entries, 18 keep (9 with a pointer fix, 2 with one line
added, 7 unchanged), 7 are rewritten, 1 merges and 4 drop; 3 skills are added.** The rewrites cluster on the
tracker (to-spec, to-tickets, wayfinder, implement, pr-description), on the
decision log (domain-modeling), and on the catalog. One constraint shapes the
rollout: every file a task touches sits under `.claude/`, which the gate
refuses from a session (see "Who runs the tasks" below).

Upstream baseline: the upstream collection's `skills/` tree at commit
`abeeaf95660ba9e8b7c753eb38f441ca707a8823` (2026-11-19), read from a local
checkout. Its categories are `engineering/`, `productivity/`, `misc/`,
`in-progress/` and `deprecated/`.

## Who can see a skill

The set only matters where a skill can load, so this comes first.

- **Workers: no skills today.** Decision 107 compiles every worker profile
  with the `Skill` tool denied unless a base or role profile layer names a
  skill (`src/core/profile-compiler.service.ts:127` `SKILL_TOOL`, the `skills`
  merge at lines 216 and 281, the keep rule at line 1663).
  `DEFAULT_BASE_PROFILE` names none. A skill reaches a worker only when a
  profile names it, so a worker-facing skill is a profile change as well as a
  skill file.
- **The conductor** keeps `Skill`, so it sees the whole project listing.
- **The operator console**, a plain Claude Code window, sees the project
  listing plus the `pup` skill, which ships from `skills/pup/` and is linked
  into `~/.claude/skills` (decision 70).
- **The CI review**: `.github/workflows/claude-code-review.yml` sends the
  prompt `/pr-ci-review` through `anthropics/claude-code-action`.
- **Humans** working in the repo by hand.

So every skill below is written for the console, the conductor, the CI
review, or a human. None is written for a worker until a profile names it.

## The skill map, derived from the loop

The loop is in `skills/pup/SKILL.md` and `skills/pup/LOOP.md`. Each stage
below names who acts there and which skill serves it.

| Loop stage | Who acts | Skill that serves it |
| --- | --- | --- |
| Intake: an issue is filed, labelled `ready`, checked (decision 176) | operator console | **triage** (new) |
| Design: a note with the slice list, `design-approved` (decisions 173, 176) | operator console, human | grilling, grill-me, grill-with-docs, domain-modeling, codebase-design, prototype, research, wizard, to-questionnaire, wait-what |
| Plan: one task per slice, `pup plan add --scope --accept` | console, conductor | to-spec, to-tickets, wayfinder |
| Launch and steer | console, conductor | the `pup` skill; handoff for the console's own context |
| Review before the gate (LOOP.md §2) | console, conductor | **code-review** (new) |
| Gate: `pup merge <task> --pr` | console, conductor | the `pup` skill; pr-description for PRs pup does not open |
| CI review and fix rounds (decision 90) | CI, conductor | pr-ci-review; `pup ci wait` and `pup fix` |
| Land, audit, retro | operator | retro, review-retro, `pup retro` |
| Work outside a session | human, console | implement, tdd, diagnosing-bugs, improve-codebase-architecture, address-review-comments |
| Writing for agents | anyone editing prompts | writing-for-agents |
| Learning pupitre | a new operator or contributor | **teach** (new) |

Three gaps show. Intake has no skill. The review before the gate is a
sentence in LOOP.md and nothing more. Onboarding has nothing at all. Two
stages have skills that duplicate pup: implement-spec drives a hand loop of
launch, wait and merge that `pup plan`, `pup launch` and the conductor run,
and `pr-description/templates/session.md` duplicates `prBody()` at
`src/core/merge-gate.service.ts:3812`, which writes every session PR body.

## Verdicts

The directory holds 29 skill directories and `README.md`, 30 entries in all.
The catalog README gets a verdict like a skill, since it is part of what the
listing loads and the rework rewrites it.

| # | Entry | Verdict | Reason |
| --- | --- | --- | --- |
| 1 | `README.md` | rewrite | It says there is no tracker and points at `docs/09-decisions.md` four times. It groups skills by theme; it should group them by loop stage as in the map above and record each skill's upstream path. |
| 2 | address-review-comments | keep, one line added | Human-in-the-loop answers to review comments still serve PRs pup did not open. Add one line saying `pup fix` owns a session PR's threads (decision 90), so the skill never replies on top of pup's own replies. |
| 3 | caveman | drop | A personal output style with no tie to the loop and no upstream. It belongs in the operator's `~/.claude/skills`, where every repo gets it. |
| 4 | codebase-design | keep, pointer fix | Serves the design stage. One stale pointer in `DESIGN-IT-TWICE.md`. |
| 5 | daily-note | drop | A personal journal tied to a Linear MCP and an Obsidian vault. Nothing in the loop reads it. Move it to `~/.claude/skills`. |
| 6 | diagnosing-bugs | keep, pointer fix | Serves bug tickets: decision 176 wants the reproduction as a failing test first, which this skill already drives. |
| 7 | domain-modeling | rewrite | It writes decisions as `##` sections in `docs/09-decisions.md` and says there is no `docs/adr/`. Decision 109 is the opposite. Adopt upstream's `ADR-FORMAT.md`, adapted to 109's file shape and `scripts/adr-index.sh`. |
| 8 | grill-me | keep | Identical to upstream, no repo pointer. |
| 9 | grill-with-docs | keep | Two lines that load grilling and domain-modeling; it follows domain-modeling's rewrite for free. |
| 10 | grilling | keep | Two lines off upstream, no stale pointer. |
| 11 | handoff | keep | Identical to upstream. The console has no pup compaction; workers and the conductor use pup's own reset (decisions 199, 200), so there is no overlap. |
| 12 | implement | rewrite | It reads the ticket from "the configured tracker (or docs/plans)". It becomes the hand path for one GitHub issue or one pup task: read the issue with `gh issue view`, stay inside the task's scope, use tdd, commit. |
| 13 | implement-spec | merge into to-tickets | It runs a hand loop (`gh pr checks --watch`, close tickets) that pup now runs: one task per slice, the conductor, `pup ci wait`. LOOP.md forbids `gh pr checks --watch`. What is left, turning a spec's slices into launched tasks, is to-tickets' last step. |
| 14 | improve-codebase-architecture | keep, pointer fix | Serves refactor tickets. Four stale pointers. |
| 15 | obsidian-vault | drop | A personal integration, no loop tie. Move to `~/.claude/skills`, and remove its `.env.example` keys. |
| 16 | pr-ci-review | keep, pointer fix | The CI review is the right shape and pup depends on its thread format (decision 90). Its MCP ticket clause becomes GitHub issues only, and one stale pointer goes. |
| 17 | pr-description | rewrite | It says the repo has no tracker and forbids `Closes`. A PR born from an issue must now say `Closes #N`. Drop `templates/session.md`: pup writes session PR bodies itself. |
| 18 | prototype | keep, pointer fix | Serves the design stage. One stale pointer in `LOGIC.md`. |
| 19 | research | keep, pointer fix | It saves to `docs/research/`, which does not exist. A research answer is a spike, so it saves to `docs/spikes/<date>-<slug>.md`, the folder this file is in. |
| 20 | retro | keep, one line added | It reviews the session's steering. Add a pointer to `pup retro` for where the tokens went (decision 192), so the two do not overlap. |
| 21 | review-retro | keep | Tunes the CI reviewer agents from PR outcomes; no stale pointer, no upstream. |
| 22 | tdd | keep, pointer fix | The default for bug reproductions and feature slices. One stale pointer. |
| 23 | to-questionnaire | keep | Two lines off upstream, no stale pointer. |
| 24 | to-spec | rewrite | Its publish step uses `mcp__linear-server__save_issue` and four `TRACKER_*` IDs. It publishes a feature issue with `gh issue create` from the `feature.yml` form's fields instead, and it never adds `ready` or `design-approved`. |
| 25 | to-tickets | rewrite | It publishes through Linear placeholders. It becomes the design note's slice list of decision 176 (each slice's files, size, dependencies, with an edge wherever files overlap), then one `pup plan add "<goal>" --scope ... --accept ...` per slice, and takes in implement-spec's launch step. |
| 26 | wait-what | keep, pointer fix | One stale pointer. |
| 27 | wayfinder | rewrite | Its tracker mode is all Linear placeholders and its fallback says there is no tracker. Port upstream's GitHub wayfinding operations (map issue, sub-issues, native blocking, claim by assignee). |
| 28 | wizard | keep | Identical to upstream but for a small `template.sh` edit, no stale pointer. |
| 29 | writing-for-agents | keep, pointer fix | Its house-rules line names `docs/09-decisions.md` and "issue trackers"; both change. It also gains the sync rule's one-line reminder, since it is the skill read before editing any skill. |
| 30 | zoom-out | drop | A one-line prompt with no upstream. The `architecture-explainer` agent does the same job with more structure. |

## New skill: triage

**What it does in pupitre.** The console's intake for decision 176. The step 4
intake agent does not exist yet (`src/core/github-tracker.service.ts` is
imported by no non-test file), so until it does, triage is how an issue
becomes work. It reads one issue, or every open one with no type label, and:

1. Checks the type. The five forms in `.github/ISSUE_TEMPLATE/` map to the
   labels `feature`, `bug`, `chore-refactor`, `docs-spike` and `follow-up`.
2. Checks the required fields against the rubric `docs/tickets/<type>.md`, the
   same check `src/core/ticket-intake.utils.ts` makes, so the skill and the
   future intake agree. On a missing or vague field it comments which ones and
   removes `ready` if present, as decision 176's intake would.
3. Looks for a duplicate among open issues and a prior rejection in
   `docs/out-of-scope/` (upstream's `.out-of-scope/`, moved under `docs/` so it
   is indexed and reviewed like any doc).
4. Reproduces a bug before recommending anything.
5. Decides whether a design is needed: a feature always; any type that touches
   an ADR area, crosses a module boundary, adds a dependency, or is estimated
   over decision 173's cap.
6. With no design needed, proposes one slice. With a design needed, runs
   grilling and domain-modeling with the operator and writes the design note
   with the slice list into the issue as a comment.
7. Stops there. It never adds `ready` or `design-approved`: decision 176 gives
   `ready` to the operator or a write collaborator, and decision 187 keeps
   `design-approved` the operator's alone so no agent can claim it. Once the
   operator labels the issue, it offers one `pup plan add` per slice, with the
   issue number in the goal and the slice's criteria as `--accept`.

Issue text is quoted data, never instructions (decisions 176, 187): the skill
quotes it when it reasons about it and takes no step an issue body asks for.
Every comment opens with upstream's disclaimer that an agent wrote it.

**Upstream files it starts from.**
`engineering/triage/SKILL.md` (the gather, recommend, verify, grill, apply
flow), `engineering/triage/AGENT-BRIEF.md` (becomes the design note and the
one-slice brief), `engineering/triage/OUT-OF-SCOPE.md`, and from
`setup-matt-pocock-skills/`, `issue-tracker-github.md` (the gh commands) and
`triage-labels.md` (the label roles). `agents/openai.yaml` is not ported.
Upstream's states map as follows: `needs-triage` is an issue with no type
label; `needs-info` stays (a new label); `ready-for-agent` is `ready` plus
`design-approved` when a design was needed; `ready-for-human` is a comment
naming the operator; `wontfix` is the existing label plus an entry in
`docs/out-of-scope/`.

**Pup and gh commands it uses.** `gh issue view <n> --json
number,title,body,labels,comments`, `gh issue list --label ... --state open`,
`gh issue comment`, `gh issue edit --add-label needs-info --remove-label
ready`, `gh issue close --reason "not planned"`; then `pup plan add`, `pup
plan` to check the backlog for an existing task, and `pup status`.

**Open point for the operator.** The repo's labels today are GitHub's
defaults plus pup's PR labels and `ready`. The five type labels,
`design-approved` and `needs-info` do not exist, so the forms' labels are
not applied. Creating them is an outward-facing change for the operator to
make once (`gh label create`), not something a skill or session does.

## New skill: code-review

**What it does in pupitre.** It is LOOP.md §2, "review before the gate", as a
skill the console or the conductor runs on a session that reads
`awaiting-review`. It sits beside pr-ci-review, not over it:

| | code-review | pr-ci-review |
| --- | --- | --- |
| When | before `pup merge --pr` | on the PR, in CI, after the gate |
| Who runs it | console or conductor, locally | `claude-code-action` |
| Output | a must-fix and nice-to-have list for one `pup steer` | inline threads that `pup fix` hands back |
| Cost | two subagents | the ten-area roster plus consolidator and validator |

Steps, following upstream:

1. Pin the fixed point: `main...HEAD` in `.worktrees/<task>`, check
   `git rev-parse` resolves both ends and the diff is not empty.
2. Find the spec: `pup review <session>` prints the ticket's slice criteria
   (decision 187) and the file list; the task's goal and `--accept` criteria
   come from `pup plan`; a ticket number leads to `gh issue view`.
3. Find the standards: `docs/conventions/*.md`, the decisions the diff touches
   found through `docs/adr/README.md`, and upstream's smell baseline, the repo
   winning where they disagree.
4. Spawn two fresh subagents in parallel, the Standards axis as the
   `review-conventions` agent type and the Spec axis as `review-spec`, so the
   local and CI reviews judge by the same rules. A change to hook generation,
   profile compilation, the gate, or anything that shells out adds the
   `security-reviewer` agent, as LOOP.md §2 asks.
5. Aggregate under `## Must fix` and `## Nice to have`, each finding with
   file:line evidence, then a one-line summary. Must-fix items become one
   `pup steer`, naming only files in the task's scope.

Mutation probes from LOOP.md §2 stay a step the skill suggests for every new
test, on a backup copy, never `git checkout --`.

**Upstream files it starts from.** `engineering/code-review/SKILL.md`.
`agents/openai.yaml` is not ported. The two-axis split, the fixed-point check
and the "no reranking across axes" rule are kept. The output headings change
from `## Standards` and `## Spec` to a must-fix split, because the reader is
`pup steer`, not a human.

**Pup commands it uses.** `pup status`, `pup review <session>`, `pup plan`,
`pup steer <session> "<message>"`; and `git -C .worktrees/<task> diff
main...HEAD` in the main checkout. It never gates: that stays the operator's
or the conductor's next command.

## New skill: teach

**What it does in pupitre.** Onboards a new operator or contributor to
pupitre itself. The mission is driving the loop: plan a task, launch it, read
`pup status`, steer once, review, gate with `--pr`, wait on CI, run a fix
round, land, audit. Resources are `docs/00` to `docs/08`, the decisions
through `docs/adr/README.md`, and `skills/pup/LOOP.md`. Lessons practise on a
scratch task in a throwaway project, never on the operator's backlog. The
workspace lives in `docs/scratch/teach/`, which `.gitignore` ignores and
`scripts/pre-commit:59` blocks, so no lesson file is ever committed.

**Upstream files it starts from.** `productivity/teach/SKILL.md`,
`MISSION-FORMAT.md`, `RESOURCES-FORMAT.md` and `LEARNING-RECORD-FORMAT.md`.
`GLOSSARY-FORMAT.md` is ported only if domain-modeling's rewrite does not
already give the repo a glossary format; the teach workspace then points at
that one.

**Pup commands it uses.** `pup status`, `pup plan`, `pup plan add`, `pup
launch`, `pup steer`, `pup review`, `pup merge --pr`, `pup ci wait`, `pup
fix`, `pup land`, `pup audit`, `pup log`, all against the throwaway project
with `--project <id>`.

## Stale pointers and tracker placeholders

Line numbers are on main at `72adb83e`. "ADR path" in the replacement column
means: point at `docs/adr/`, found through the index `docs/adr/README.md`,
and say the decisions win over `docs/00` to `docs/08`.

| File:line | What is stale | Replacement |
| --- | --- | --- |
| `.claude/skills/README.md:14` | "There is no issue tracker here (`pup plan` is the backlog)" | GitHub Issues are the tracker (decision 176); `pup plan` is the backlog of tasks |
| `.claude/skills/README.md:15` | specs and tickets fall back to `docs/plans/` | `docs/plans/` does not exist and pre-commit blocks it; specs and tickets are GitHub issues |
| `.claude/skills/README.md:23` | `docs/09-decisions.md` | ADR path |
| `.claude/skills/README.md:45` | `docs/09-decisions.md` | ADR path |
| `.claude/skills/README.md:67` | "adapted to this repo's docs layout (`docs/09-decisions.md`, ...)" | the upstream ledger `docs/skills-upstream.md` |
| `.claude/skills/README.md:76` | "no tracker MCP in this repo" | GitHub through `gh`, no MCP |
| `.claude/skills/domain-modeling/SKILL.md:3` | description names `docs/09-decisions.md` | ADR path |
| `.claude/skills/domain-modeling/SKILL.md:8` | `docs/09-decisions.md` | ADR path |
| `.claude/skills/domain-modeling/SKILL.md:15` | table row `docs/09-decisions.md` | `docs/adr/NNNN-short-kebab-title.md` |
| `.claude/skills/domain-modeling/SKILL.md:19` | "This repo has **no `docs/adr/`**" and "not as an ADR file" | one file per decision under `docs/adr/` (decision 109) |
| `.claude/skills/domain-modeling/SKILL.md:27` | conflicts with `docs/09-decisions.md` | ADR path |
| `.claude/skills/domain-modeling/DECISION-FORMAT.md:3` | "Decisions live in `docs/09-decisions.md` ... There is no `docs/adr/`" | file deleted; `ADR-FORMAT.md` replaces it |
| `.claude/skills/domain-modeling/DECISION-FORMAT.md:7` | `docs/09-decisions.md` wins | as above |
| `.claude/skills/domain-modeling/DECISION-FORMAT.md:13` to `:15` | `##` section headings, which decision 109 dropped | the file opens with `# NNNN. Title`, `- Status:`, `- Amends:` |
| `.claude/skills/domain-modeling/DECISION-FORMAT.md:35` | numbering from `git show origin/main:docs/09-decisions.md \| grep` | highest number from `git ls-tree --name-only origin/main docs/adr/`, then `bash scripts/adr-index.sh` |
| `.claude/skills/wayfinder/SKILL.md:75` | "With an issue-tracker MCP server configured" | GitHub Issues through `gh` |
| `.claude/skills/wayfinder/SKILL.md:77` | `mcp__linear-server__*`, `TRACKER_TEAM_ID`, `TRACKER_PROJECT_ID`, `TRACKER_ASSIGNEE_ID` | `gh issue`; no IDs (gh infers the repo) |
| `.claude/skills/wayfinder/SKILL.md:79` | `mcp__linear-server__save_issue` | `gh issue create` with the `wayfinder:map` label |
| `.claude/skills/wayfinder/SKILL.md:80` | `parentId` | sub-issues (`--parent`, `--add-sub-issue`) |
| `.claude/skills/wayfinder/SKILL.md:81` | `save_issue`'s `blockedBy` | native blocking (`--add-blocked-by`, `issue_dependencies_summary.blocked_by`) |
| `.claude/skills/wayfinder/SKILL.md:82` | `mcp__linear-server__list_issues` | `gh issue list` |
| `.claude/skills/wayfinder/SKILL.md:83` | `${TRACKER_ASSIGNEE_ID}` | `gh issue edit --add-assignee @me` |
| `.claude/skills/wayfinder/SKILL.md:84` | `mcp__linear-server__create_comment` | `gh issue comment` then `gh issue close` |
| `.claude/skills/wayfinder/SKILL.md:86` | "there is no issue tracker in this repo" | removed |
| `.claude/skills/wayfinder/SKILL.md:93` | `docs/09-decisions.md` | ADR path |
| `.claude/skills/to-tickets/SKILL.md:13` | `mcp__linear-server__*` placeholders, IDs from `.env` | `gh issue`, no IDs |
| `.claude/skills/to-tickets/SKILL.md:15` to `:18` | `${TRACKER_ASSIGNEE_ID}`, `${TRACKER_TEAM_ID}`, `${TRACKER_PROJECT_ID}`, `${TRACKER_ISSUE_PREFIX}` | removed |
| `.claude/skills/to-tickets/SKILL.md:20` | no-tracker fallback to `docs/plans/` | removed |
| `.claude/skills/to-tickets/SKILL.md:26` | `mcp__linear-server__get_issue` | `gh issue view <n> --json ...` |
| `.claude/skills/to-tickets/SKILL.md:30` | `docs/09-decisions.md`, twice | ADR path |
| `.claude/skills/to-tickets/SKILL.md:72` | `mcp__linear-server__save_issue`, `parentId`, `blockedBy` | the design note's slice list, then `pup plan add` per slice; sub-issues and `--add-blocked-by` when slices are filed as issues |
| `.claude/skills/to-tickets/SKILL.md:95` | `${TRACKER_ISSUE_PREFIX}-XXXX` | `#N` |
| `.claude/skills/to-spec/SKILL.md:11` | tracker placeholders | `gh issue create` from the `feature.yml` fields |
| `.claude/skills/to-spec/SKILL.md:13` to `:16` | `${TRACKER_ASSIGNEE_ID}`, `${TRACKER_TEAM_ID}`, `${TRACKER_PROJECT_ID}`, `${TRACKER_EPIC_LABEL_ID}` | removed; the `feature` label |
| `.claude/skills/to-spec/SKILL.md:18` | no-tracker fallback | removed |
| `.claude/skills/to-spec/SKILL.md:22` | `docs/09-decisions.md`, twice | ADR path |
| `.claude/skills/to-spec/SKILL.md:28` | `mcp__linear-server__save_issue` | `gh issue create` |
| `.claude/skills/daily-note/SKILL.md:4` | `mcp__linear-server__list_issues`, `list_issue_statuses` in `allowed-tools` | skill dropped |
| `.claude/skills/daily-note/SKILL.md:5`, `:10`, `:12` to `:15`, `:23`, `:36`, `:51`, `:63`, `:67`, `:88` | issue-tracker setup, `${TRACKER_*}`, tracker sync and priority | skill dropped |
| `.claude/skills/implement/SKILL.md:7`, `:9` | "configured tracker (or its file under `docs/plans/` ...)" | `gh issue view <n>`, or the pup task's goal and criteria |
| `.claude/skills/implement-spec/SKILL.md:9` | "configured tracker (IDs from `.env`), or under docs/plans" | skill merged into to-tickets |
| `.claude/skills/implement-spec/SKILL.md:11` | "issue tracker closes work" | as above |
| `.claude/skills/implement-spec/SKILL.md:39` | `gh pr checks <number> --watch`, which LOOP.md §4 forbids | `pup ci wait <task>`, in to-tickets' launch step |
| `.claude/skills/pr-ci-review/SKILL.md:6` | `--spec <... ticket id>` | `--spec <issue number or path>` |
| `.claude/skills/pr-ci-review/SKILL.md:60` | "a ticket only an MCP tool can fetch" | a GitHub issue, read with `gh issue view` as `review-spec` already does |
| `.claude/skills/pr-ci-review/SKILL.md:76` | `docs/09-decisions.md` | ADR path |
| `.claude/skills/pr-description/SKILL.md:45` to `:48` | "**This repo has no issue tracker.** ... no `Closes` line" | `Closes #N` for a PR born from an issue; session PR bodies are `prBody()`'s |
| `.claude/skills/pr-description/SKILL.md:147` | "There is no tracker id" | the issue number |
| `.claude/skills/pr-description/SKILL.md:169` | "link tracker issues by id/URL only" | `#N` |
| `.claude/skills/pr-description/SKILL.md:170` | "No `Closes`" | `Closes #N` |
| `.claude/skills/writing-for-agents/SKILL.md:87` | `docs/09-decisions.md` wins; "never create a `CONTEXT.md` or a glossary" | ADR path; the glossary rule follows domain-modeling's rewrite |
| `.claude/skills/writing-for-agents/SKILL.md:90` | "issue trackers" as an external example | GitHub Issues |
| `.claude/skills/wait-what/SKILL.md:7` | `docs/09-decisions.md` | ADR path |
| `.claude/skills/diagnosing-bugs/SKILL.md:10` | `docs/09-decisions.md` | ADR path |
| `.claude/skills/tdd/SKILL.md:10` | `docs/09-decisions.md` | ADR path |
| `.claude/skills/improve-codebase-architecture/SKILL.md:14`, `:25`, `:54`, `:68` | `docs/09-decisions.md` | ADR path |
| `.claude/skills/codebase-design/DESIGN-IT-TWICE.md:30` | `docs/09-decisions.md` | ADR path |
| `.claude/skills/prototype/LOGIC.md:39` | `docs/09-decisions.md` | ADR path |
| `.claude/skills/research/SKILL.md:12` | saves to `docs/research/`, which does not exist | `docs/spikes/<date>-<slug>.md` |
| `.env.example:13` | "to-issues / to-epic skills, IDs from your issue tracker (e.g. Linear)" | removed |
| `.env.example:15` to `:19` | `TRACKER_ASSIGNEE_ID`, `TRACKER_TEAM_ID`, `TRACKER_PROJECT_ID`, `TRACKER_EPIC_LABEL_ID`, `TRACKER_ISSUE_PREFIX` | removed; gh needs none |
| `.env.example:10`, `:11`, `:21`, `:22` | `OBSIDIAN_VAULT`, `OBSIDIAN_DAILY_DIR` | removed with obsidian-vault and daily-note |
| `.claude/agents/convention-checker.md:14` | "contains exactly three files" | four: `general.md`, `naming.md`, `shell.md`, `testing.md` |

Not stale: `improve-codebase-architecture/HTML-REPORT.md:23` matches "linear"
only in the CSS `linear-gradient`.

## Staying in step with upstream

**Where drift is recorded.** One file, `docs/skills-upstream.md`, holds:

- the upstream repository and the pinned commit the local copies were last
  synced to (today `abeeaf95660ba9e8b7c753eb38f441ca707a8823`);
- one row per local skill file: its local path, its upstream path (or
  `local only`), and its status, one of `verbatim`, `adapted` or `local only`;
- for every `adapted` file, the list of intended deviations, one line each,
  each naming the reason (for example "decision 109: ADRs under `docs/adr/`",
  "decision 176: GitHub Issues through `gh`", "pup owns this: `pup ci wait`").

The catalog README links each skill to its ledger row instead of repeating it.

**The sync rule.**

1. A commit that edits a local skill file updates its ledger row in the same
   commit: a new deviation line, or `verbatim` turned to `adapted`. An edit
   with no ledger change must be bringing the file back to upstream.
2. A re-sync is a deliberate task, not a side effect. It reads upstream's
   changes since the pin, takes each one into the local file unless it hits a
   recorded deviation, re-applies the deviations, and moves the pin, all in
   one commit.
3. A new upstream skill is not copied by default. It is added only by a task
   that gives it a verdict as this spike does.

**How drift is detected.** `scripts/skills-drift.sh <upstream-checkout>`
reads the ledger and, for each row:

- `verbatim`: the local file must equal upstream's at the pin; any difference
  is unrecorded drift.
- `adapted`: it prints the changed-line count against upstream at the pin, so
  a reviewer sees a count that grew without a new deviation line.
- with `--since-pin`, it lists the upstream files changed between the pin and
  the checkout's head, which is the re-sync's work list.
- a local skill file with no ledger row, or a row whose file is gone, fails.

The script needs an upstream checkout, which CI does not have, so it is not a
`pnpm lint` stage. It runs at every re-sync and in any task that edits a
skill, and the last check (every file has a row) can run alone without the
checkout, so that part can join `pnpm lint` later if drift shows up anyway.

Measured drift today, in changed lines against the pin: identical for
grill-me, handoff, `wizard/SKILL.md`, `writing-for-agents/SKILL-MECHANICS.md`,
`codebase-design/DEEPENING.md`, the diagnosing-bugs loop script and
`improve-codebase-architecture/HTML-REPORT.md`; under 35 for every other
adapted file (largest: wayfinder 32, to-tickets 29, to-spec 19,
implement-spec 19, prototype `UI.md` 18); domain-modeling's `SKILL.md` 75,
with `DECISION-FORMAT.md` local only and upstream's `ADR-FORMAT.md` and
`GLOSSARY-FORMAT.md` absent. Local only, with no upstream: zoom-out, caveman,
daily-note, obsidian-vault, pr-ci-review, address-review-comments,
review-retro, and pr-description (upstream's counterpart is named `pr`).

## Who runs the tasks

Every row below but T16 and T17 edits `.claude/` (T12 also adds one file under `docs/`), and the gate refuses
`.claude/**` from a session (LOOP.md, gotchas). The rows are written so each
can still be one session if the operator grants it, or one operator commit
from the console otherwise. Which of the two is the operator's call, and this
spike does not make it.

## Implementation tasks

Paths are relative to the repo root. "New" creates a file, "delete" removes
it, anything else edits it. No file appears in two rows. Sizes: S under about
50 changed lines, M under about 200, L above.

| # | Task | Scope-in files | Size | Depends on |
| --- | --- | --- | --- | --- |
| T1 | domain-modeling writes decisions under `docs/adr/` per decision 109 | `.claude/skills/domain-modeling/SKILL.md`; new `.claude/skills/domain-modeling/ADR-FORMAT.md`; delete `.claude/skills/domain-modeling/DECISION-FORMAT.md` | M | none |
| T2 | Pointer fixes to the ADR path and to `docs/spikes/` | `.claude/skills/wait-what/SKILL.md`, `.claude/skills/diagnosing-bugs/SKILL.md`, `.claude/skills/tdd/SKILL.md`, `.claude/skills/improve-codebase-architecture/SKILL.md`, `.claude/skills/codebase-design/DESIGN-IT-TWICE.md`, `.claude/skills/prototype/LOGIC.md`, `.claude/skills/research/SKILL.md` | S | none |
| T3 | writing-for-agents: ADR path, GitHub Issues, the sync rule reminder | `.claude/skills/writing-for-agents/SKILL.md` | S | T1 |
| T4 | to-spec publishes a feature issue with `gh` | `.claude/skills/to-spec/SKILL.md` | M | none |
| T5 | to-tickets writes the slice list and plans one pup task per slice; implement-spec merges in | `.claude/skills/to-tickets/SKILL.md`; delete `.claude/skills/implement-spec/SKILL.md` | M | none |
| T6 | wayfinder on GitHub Issues | `.claude/skills/wayfinder/SKILL.md` | M | none |
| T7 | implement reads a GitHub issue or a pup task | `.claude/skills/implement/SKILL.md` | S | none |
| T8 | pr-description: `Closes #N`, session bodies left to `prBody()` | `.claude/skills/pr-description/SKILL.md`; delete `.claude/skills/pr-description/templates/session.md` | S | none |
| T9 | pr-ci-review: GitHub issues as the spec, ADR path | `.claude/skills/pr-ci-review/SKILL.md` | S | none |
| T10 | retro and address-review-comments point at `pup retro` and `pup fix` | `.claude/skills/retro/SKILL.md`, `.claude/skills/address-review-comments/SKILL.md` | S | none |
| T11 | Drop the personal skills and zoom-out, and the env keys only they and the tracker placeholders read | delete `.claude/skills/caveman/SKILL.md`, `.claude/skills/obsidian-vault/SKILL.md`, `.claude/skills/daily-note/SKILL.md`, `.claude/skills/zoom-out/SKILL.md`; `.env.example` | S | T4, T5, T6 |
| T12 | New triage skill and the out-of-scope knowledge base | new `.claude/skills/triage/SKILL.md`, `.claude/skills/triage/AGENT-BRIEF.md`, `.claude/skills/triage/OUT-OF-SCOPE.md`, `docs/out-of-scope/README.md` | M | T5 |
| T13 | New code-review skill | new `.claude/skills/code-review/SKILL.md` | M | none |
| T14 | New teach skill | new `.claude/skills/teach/SKILL.md`, `.claude/skills/teach/MISSION-FORMAT.md`, `.claude/skills/teach/RESOURCES-FORMAT.md`, `.claude/skills/teach/LEARNING-RECORD-FORMAT.md` | M | T1 |
| T15 | convention-checker counts four convention files | `.claude/agents/convention-checker.md` | S | none |
| T16 | The pup skill names code-review for the review before the gate | `skills/pup/SKILL.md`, `skills/pup/LOOP.md` | S | T13 |
| T17 | Upstream ledger and drift check | new `docs/skills-upstream.md`, new `scripts/skills-drift.sh` | M | T1 to T14 |
| T18 | Catalog by loop stage, linked to the ledger | `.claude/skills/README.md` | M | T1 to T14, T17 |

T17 comes after the skill rows because the ledger records each row's final
deviations; writing it first would put its file in every row.
