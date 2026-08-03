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
  baseline drift, and live/queued session goals. Rendering only — no new
  collection. Design questions before building (one page vs a richer mind-map;
  on-demand vs at-merge rendering; whether intent deserves a first-class
  artefact) go through a grilling session.

  **Measured against the real store before that conversation (2026-08-03, pupitre's
  own 11 days: 14 sessions, 24 gate reports, 13 decision records).** Only one of
  the five sections works as written, so these are constraints on the design
  conversation, not outcomes of it:

  - **Baseline drift is renderable since decision 38 (2026-08-03).** The blocking
    schema decision is settled: `baseline_history` appends one row per capture
    (`pup init` and every `pup audit`) before `projects.baseline` is overwritten,
    and the first capture on an upgraded store seeds the pre-table baseline, so
    the report reads the whole trend with a pure SELECT (`listBaselineHistory`).
    Remaining gap, per the decision's stated ceiling: the merge-gate debt ratchet
    moves the bar without a history row, so the trend is audit-to-audit.
  - **"Session intent dies unrendered with the session" is false**, and the
    original entry said so. Every goal, scope and acceptance list is in
    `tasks.spec` permanently; it has simply never been read back. This is the
    cheapest section to build, not the most speculative. It needs a `listTasks`
    SELECT, which does not exist yet (nor does `listEvents`) — both still pure reads.
  - **The code map is not a store read.** `buildCodeMap` shells out to `git log`
    for churn and calls `adapter.depGraph`, and throws without one. Including it
    contradicts "rendering only".
  - **Open debt renders empty** on a healthy project — all ledger entries are
    closed, and every `review_by` is prose, so nothing computes as overdue.
  - **Live/queued sessions render empty** for the same reason: sessions are
    terminal once merged. A report opening on live state is blank most of the time
    it is opened, while 13 merged sessions of history go unshown.

  Two hazards for whoever builds it: reuse the mind-map's escaping idiom verbatim
  (JSON in a script tag with `<` escaped, everything injected via `textContent`) —
  goals and reasons are agent-written free prose; and SQLite's `created_at` has no
  timezone, so JavaScript parses `2026-08-03 12:36:05` as local time.

## v2 — team (explicitly out of scope until v1.2 is daily-driven)

- Shared state server, multi-human review queues, policy enforcement, CI integration.

## Risks

- Gate gaming: agents optimise for metrics over intent. Mitigation: random deep review of low-risk merges; deltas not absolutes; human owns the ledger.
- Knowledge rot: mitigation is structural (generation only, merge-transaction refresh), see 05.
- Context bloat: budget caps are hard, compiler refuses over-cap output.
- Claude Code interface drift: hooks and headless flags evolve; isolate all Claude Code interaction behind one internal module.
