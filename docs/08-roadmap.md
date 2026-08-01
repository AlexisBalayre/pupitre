# Roadmap

## Stack decision

TypeScript. Claude Code is Node-based, its hooks and Agent SDK are TypeScript-first, and the v1 adapters cover TypeScript and Python targets regardless of the tool's own language. SQLite via better-sqlite3, commander for the CLI.

## v1 — control (the week-of-evenings cut)

- Profile compiler: base + role + task layers, token budget, hash recording.
- Worktree lifecycle: `pup new`, `pup status`, `pup kill`, session state machine, event log.
- Scope hook (PreToolUse) and event hook (PostToolUse).
- Basic merge gate: build, tests, lint, scope audit. Delta metrics limited to coverage and diff size.
- Task specs and `--accept-debt` with a minimal ledger.
- TypeScript adapter only.

Definition of done: run three parallel sessions on a real repo for a week without hand-editing any worktree config, and reject at least one merge through the gate.

## v1.1 — knowledge

- Code map generation and injection, `pup map` text view.
- Decision records at merge, `pup log`.
- Full debt-delta stage (duplication, dead code, complexity) and the ratchet.
- Python adapter. `pup init` audit and baseline for existing repos.
- Reviewer subagent in the gate. Risk-scored `pup review` queue.

## v1.2 — visibility

- Interactive mind-map (`pup map --open`).
- Watcher daemon: live conflict radar in `pup status`.
- `pup audit --sweep` deletion sessions. Custom adapter escape hatch.
- `pup report --open`: one self-contained per-project HTML page in the mind-map's
  house style (inline CSS/JS, offline, no CDN) stitching what the store already
  holds — code map, decision records, open debt ledger with review-by conditions,
  baseline drift, and live/queued session goals. The last of these is the only
  view of "what will be built" pupitre has; today session intent dies unrendered
  with the session. Rendering only — no new collection. Design questions before
  building (one page vs a richer mind-map; on-demand vs at-merge rendering;
  whether intent deserves a first-class artefact) go through a grilling session.

## v2 — team (explicitly out of scope until v1.2 is daily-driven)

- Shared state server, multi-human review queues, policy enforcement, CI integration.

## Risks

- Gate gaming: agents optimise for metrics over intent. Mitigation: random deep review of low-risk merges; deltas not absolutes; human owns the ledger.
- Knowledge rot: mitigation is structural (generation only, merge-transaction refresh), see 05.
- Context bloat: budget caps are hard, compiler refuses over-cap output.
- Claude Code interface drift: hooks and headless flags evolve; isolate all Claude Code interaction behind one internal module.
