# Claude Code Configuration

This directory contains all Claude Code customizations for Pupitre. Everything here extends Claude's agentic loop: the cycle of reasoning, tool use, and iteration that powers every session.

## How It All Fits Together

```
┌─────────────────────────────────────────────────────────┐
│                    Always-On Context                     │
│  AGENTS.md via CLAUDE.md (project rules, commands)       │
│  Rules without paths (unconditional)                     │
│  Skill descriptions (names + one-liners)                 │
│  MCP tool schemas                                        │
├─────────────────────────────────────────────────────────┤
│                    On-Demand Context                      │
│  Rules with paths (load when matching files opened)      │
│  Skill full content (load when invoked/relevant)         │
│  Subdirectory CLAUDE.md files                            │
├─────────────────────────────────────────────────────────┤
│                    Isolated Context                       │
│  Subagents (own context window, return summary)          │
├─────────────────────────────────────────────────────────┤
│                    External (Zero Cost)                   │
│  Hooks (shell scripts, no LLM, deterministic)            │
└─────────────────────────────────────────────────────────┘
```

**Context budget matters.** Everything in "Always-On" consumes tokens every turn. Rules with `paths:` and skills with descriptions load on-demand, saving context. Subagents run in isolated windows. Hooks cost zero context.

What a session pays for this config, in approximate tokens (bytes / 4), so additions stay deliberate:

| Surface | Loaded | Cost |
|---|---|---|
| `CLAUDE.md` + `AGENTS.md` | every session | ~1.0k |
| Descriptions of the model-invocable skills | every session | ~0.7k |
| Descriptions of all 11 agents | every session | ~0.7k |
| `docs/conventions/general.md` + `naming.md` | first `.ts` file touched | ~3.1k |
| `docs/conventions/testing.md` | first test file touched | ~1.2k |

A rule fires on the first Read, Edit, or Write of a matching path (not on MCP results such as codegraph) and its `@import` pulls the whole file, so each convention doc is paid once per session per area. Keep them obligations-only, never instruct the model to Read one, and prefer `disable-model-invocation: true` for user-only skills since agents have no equivalent switch.

---

## Directory Structure

```
.claude/
├── settings.json              # Shared project config (permissions, hooks)
├── settings.local.json.example # Template for personal overrides (real file gitignored)
├── project.env                # Project profile: commands, generated paths, naming, trunk
├── spot-checks.tsv            # Checks run by convention-spot-check.sh
│
├── rules/                 # Path-scoped convention loaders (auto-load)
│   ├── core-conventions.md        # *.ts(x) → general.md + naming.md
│   └── testing-conventions.md     # tests → testing.md
│
├── skills/                # Auto-discoverable knowledge + workflows (each is <name>/SKILL.md)
│   ├── to-spec/   to-tickets/   to-questionnaire/                # planning & specs
│   ├── wayfinder/   implement/
│   ├── tdd/   diagnosing-bugs/   resolving-merge-conflicts/      # engineering
│   ├── wizard/   research/
│   ├── improve-codebase-architecture/                            # engineering (manual)
│   ├── grilling/   grill-me/   grill-with-docs/                  # thinking / design
│   ├── codebase-design/   domain-modeling/   zoom-out/   prototype/
│   ├── pr-description/   pr-ci-review/                           # PR & review
│   ├── address-review-comments/   review-retro/
│   ├── writing-for-agents/   handoff/   caveman/   wait-what/     # meta / workflow
│   └── obsidian-vault/   daily-note/                             # personal integrations (.env)
│
├── agents/                # Custom subagents for specialized tasks
│   ├── convention-checker.md                                     # proactive
│   ├── security-reviewer.md       architecture-explainer.md
│   ├── review-context.md          review-conventions.md          # dispatched by pr-ci-review
│   ├── review-correctness.md      review-docs.md
│   ├── review-maintainability.md  review-security.md
│   ├── review-validator.md
│   └── comment-pruner.md          # dispatched by the comment-pruner Stop hook
│
└── hooks/                    # Deterministic shell scripts (zero LLM cost)
    ├── quality-checks.sh          # Stop: format/lint dirty files + repo typecheck
    ├── convention-spot-check.sh   # Stop: spot-checks.tsv scan (blocks once)
    ├── comment-pruner.sh          # Stop: dispatch the comment-pruner subagent on new comments
    ├── git-safety.sh              # PreToolUse(Bash): block dangerous git/shell ops
    ├── protect-generated.sh       # PreToolUse(Edit|Write): block generated files
    ├── validate-file-naming.sh    # PreToolUse(Write): enforce the project's file naming
    ├── pre-compact-preserve.sh    # PreCompact: inject must-preserve context
    └── lib/project-env.sh         # reads project.env without executing it
```

---

## Extension Points Explained

### 1. `AGENTS.md` + `CLAUDE.md` — Project Memory

`AGENTS.md` holds the tool-neutral rules every session sees: the core rule, design-doc precedence, module boundaries, the conventions table, comments, altitude, git workflow. The root `CLAUDE.md` imports it (`@AGENTS.md`) and adds only what is Claude Code-specific (how rules load, the proactive subagents). Together under ~70 lines to minimize context cost.

**When to edit:** Add universal rules to `AGENTS.md`. For area-specific rules, use `docs/conventions/` + a loader in `rules/` instead.

### 2. `rules/` — Path-Scoped Convention Rules

Markdown files with `paths:` frontmatter that auto-load when Claude works with matching files. Each rule is a **pure loader**: `paths:` plus `@docs/conventions/<area>.md` imports, no content of its own, so `docs/conventions/` stays the single source of truth.

```yaml
---
paths:
  - "**/*.test.ts"
---
@docs/conventions/testing.md
```

**Key insight:** a rule costs nothing until a matching file is touched, then pays the whole doc once per session. Keep the docs obligations-only, and never tell the model to Read one (that duplicates what the rule already injected).

**When to add a rule:** When conventions are specific to a file path pattern and should auto-load when editing those files.

### 3. `skills/` — Auto-Discoverable Workflows

Skills are directories with a `SKILL.md` that Claude discovers automatically. Claude sees the description at session start (tiny context cost) and loads the full content when the skill is relevant.

This repo ships **28 skills** across planning, engineering, thinking/design, PR & review, meta, and personal integrations. The **[skill catalog](skills/README.md)** lists when each one fires and how to invoke it (auto-trigger, `/slash-command`, Claude-only, or manual-only).

**Frontmatter options:**
- `name` — identifier and `/slash-command` name
- `description` — when to auto-activate (critical for discovery)
- `user-invocable: false` — Claude-only (hidden from `/` menu)
- `disable-model-invocation: true` — user-only (Claude can't auto-trigger)
- `allowed-tools` — tools available without permission prompts
- `context: fork` — run in isolated subagent context
- `model` — override model when active

**When to add a skill:** When Claude should auto-discover and apply knowledge or follow a workflow without being asked. Skills are for things Claude should know to do on its own. For repeatable workflows only the user should trigger — anything with side effects like posting PR comments or filing issues — set `disable-model-invocation: true`: a manual-only skill is invoked as `/<name>` and replaces the deprecated `commands/` layer.

### 4. `agents/` — Custom Subagents

Specialized AI workers that run in their own context window. Claude delegates to them and gets summarized results back — zero bloat in the main conversation.

| Agent | Model | Tools | Purpose |
|-------|-------|-------|---------|
| `convention-checker` | Haiku | Read, Glob, Grep | Fast convention compliance audit |
| `security-reviewer` | Opus | Read, Glob, Grep, Bash | Deep security analysis |
| `architecture-explainer` | Sonnet | Read, Glob, Grep | Answer why/how architecture questions, grounded in `docs/` |
| `review-*` (7 agents) | Sonnet/Opus | Read, Glob, Grep, Bash | Area reviewers + adversarial validator, dispatched by the `pr-ci-review` skill |
| `comment-pruner` | Sonnet | Read, Edit, Grep, Glob, Bash | Prune low-value comments; dispatched by the `comment-pruner.sh` Stop hook |

**Frontmatter options:**
- `tools` — allowlist of tools (restricts to only what's needed)
- `model` — `haiku` (fast/cheap), `sonnet` (balanced), `opus` (deep reasoning)
- `memory: project` — persistent knowledge across sessions
- `isolation: worktree` — run in temporary git worktree
- `skills` — preload specific skills into subagent context
- `mcpServers` — scope MCP servers to this subagent only
- `maxTurns` — limit agentic turns

**When to add an agent:** For tasks that need deep analysis without polluting the main context, or for work that benefits from model-specific strengths (Haiku for speed, Opus for reasoning).

**Catalog:** [`agents/README.md`](agents/README.md) — every agent, when it fires, and its model/tools.

### 5. `hooks/` — Deterministic Automation

Shell scripts that run outside the LLM loop on lifecycle events. Zero context cost, zero hallucination risk — purely deterministic.

| Hook | Event | What it does |
|------|-------|-------------|
| `quality-checks.sh` | Stop | `FORMAT_FIX_CMD`/`LINT_CMD` on dirty files, `TYPECHECK_CMD` on the repo (blocks on failure; tests live in pre-commit) |
| `convention-spot-check.sh` | Stop | Run `spot-checks.tsv` over changed files; blocks once, silent on the re-run |
| `comment-pruner.sh` | Stop | Dispatch the `comment-pruner` subagent when the session added net-new comments |
| `git-safety.sh` | PreToolUse(Bash) | Block `rm -rf`, `git reset --hard`, force push, `checkout -b` on main, push to main |
| `protect-generated.sh` | PreToolUse(Edit\|Write) | Block edits to paths matching `GENERATED_PATHS_REGEX` |
| `validate-file-naming.sh` | PreToolUse(Write) | Enforce `FILE_NAMING_REGEX` on new files under this checkout |
| `pre-compact-preserve.sh` | PreCompact | Preserve branch, modified files, test output across compaction |

**Exit codes:**
- `0` — success, continue
- `1` — error (shown to user, continues)
- `2` — **block the operation** (PreToolUse: prevents tool; Stop: feedback to Claude)

**Project profile:** hooks never hardcode the toolchain. They read `.claude/project.env` (committed: Biome, tsc, pnpm, the naming regex, the trunk) through `hooks/lib/project-env.sh`, which parses `KEY=value` lines for a fixed key set and never sources the file, so a checkout cannot run code inside a hook. An empty key turns its check off. `.env` (gitignored) is only for personal-integration skills.

**When to add a hook:** For deterministic checks that should always run. If it doesn't need LLM reasoning, it's a hook.

**Catalog:** [`hooks/README.md`](hooks/README.md) — every hook, the event it fires on, and what it does.

### 6. `settings.json` — Permissions & Hook Wiring

Shared project configuration. Contains:
- **`permissions.allow`** — pre-approved tool patterns (pnpm scripts, worktree scripts, git, `gh`)
- **`permissions.deny`** — explicitly blocked operations (force push, hard reset, rm -rf)
- **`hooks`** — wires hook scripts to lifecycle events

**`settings.local.json`** (gitignored) extends this with personal preferences — additional MCP servers, machine-specific permissions, etc. Copy `settings.local.json.example` to `settings.local.json` to start; it is merged on top of `settings.json`, never replacing it.

### 7. CI review — `.github/workflows/claude-code-review.yml` + `tools/review/`

Every PR opened, pushed to, or `@claude review`-commented by the repository owner (nobody else: the run bills the owner's Claude subscription) gets the `/pr-ci-review` orchestrator run in GitHub Actions: a deterministic preflight (PR-head checkout, full-vs-incremental mode), the model with a read-only tool allowlist emitting a structured record, and a poster in `tools/review/` that renders it (inline comments for blocking findings, collapsed sections for the rest, a `claude-review` commit status). The model never writes to the PR; a dead run still posts "not reviewed". Each record lands on the `ci/review-metrics` branch for `/review-retro`. Setup and threat model: the comment at the top of the workflow and [`tools/review/README.md`](../tools/review/README.md).

---

## Decision Framework

| I want... | Use... |
|-----------|--------|
| Claude to always know this | `AGENTS.md` |
| Claude to know this when editing specific files | `rules/` with `paths:` |
| Claude to auto-discover and use this knowledge | `skills/` |
| A workflow I trigger explicitly | `skills/` with `disable-model-invocation: true` |
| Isolated analysis that won't bloat context | `agents/` |
| A check that runs every time, deterministically | `hooks/` |
| External service access | MCP (`.mcp.json`) |

---

## Adding New Extensions

### New rule
1. Create `.claude/rules/<name>.md` with `paths:` frontmatter
2. Put only `@docs/conventions/<area>.md` imports in the body, no content of its own
3. Add the area to the Conventions table in `AGENTS.md` and to the tree above

### New skill
1. Create `.claude/skills/<name>/SKILL.md` with `name` and `description` frontmatter
2. Write the full workflow/knowledge content
3. Set `user-invocable: false` if Claude-only, `disable-model-invocation: true` if user-only

### New agent
1. Create `.claude/agents/<name>.md` with `name`, `description`, and `tools`
2. Choose `model` based on task complexity (haiku/sonnet/opus)
3. Restrict `tools` to minimum needed

### New hook
1. Create `.claude/hooks/<name>.sh` (must be executable)
2. Wire it in `settings.json` under the appropriate event
3. Use exit code `2` to block operations
