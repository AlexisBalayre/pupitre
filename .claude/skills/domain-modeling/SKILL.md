---
name: domain-modeling
description: Maintain this repo's documented language as design decisions land. Use when pinning down domain terminology, recording an architectural decision, or when another skill needs the docs kept current during a session.
---

# Domain Modeling

Actively sharpen the project's documented language as you design: challenge terms, stress-test them with edge-case scenarios, and update the docs the moment a decision crystallises. Merely *reading* the docs for vocabulary is not this skill; reach for it when the language is being *changed*, not just consumed.

## Where the documented language lives in this repo

| Source                       | What it covers                                                                |
| :--------------------------- | :---------------------------------------------------------------------------- |
| `docs/00`–`08`               | The design narrative per area (overview, architecture, CLI, profiles, gates, knowledge, adapters, onboarding, roadmap) |
| `docs/09-decisions.md`       | Numbered log of resolved decisions. **Wins over 00–08 where they conflict**   |
| `docs/conventions/naming.md` | Role taxonomy and naming stems for modules                                    |
| `src/core/db.client.ts`      | `SCHEMA` — the persisted nouns, and the closest thing to a glossary this repo has |

This repo has **no `docs/adr/`, no `docs/explanation/`, and no Glossary table**. A hard-to-reverse choice is recorded as a numbered entry in `docs/09-decisions.md`, not as an ADR file.

Before a session, skim the relevant `docs/0N` doc and the decisions that touch the area. For *why*/*how* questions spanning module boundaries, delegate to the `architecture-explainer` subagent rather than re-reading docs in the main context.

## During the session

### Challenge against the existing language

When the user uses a term that conflicts with `docs/09-decisions.md` or `naming.md`, call it out. Example: "Decision 13 defines coverage as *patch* coverage against a ratcheting baseline; you're using it for the repo-wide ratio. Which do you mean?"

### Sharpen fuzzy language

Propose precise canonical terms; pull from the decisions log and the `SCHEMA` nouns first, only invent when nothing fits. Common ambiguities here:

- "Session" (the `sessions` row vs. the tmux window vs. the `claude -p` process)
- "Gate" (the whole merge pipeline vs. one stage within it)
- "Baseline" (the stored per-project debt figures vs. the locked main checkout a stage measures against)
- "Debt" (a ledger entry vs. the measured delta that produced it)
- "Project" vs. "worktree" vs. "checkout"

### Stress-test with concrete scenarios

Force precision with edge cases that touch module boundaries:

- "A stage measures the branch worktree but the baseline was recorded from main — same denominator?"
- "Two sessions touch the same file and both pass their gate; when does the overlap surface?"
- "`--accept-debt` on a flagged stage: what exactly lands in `ledger_entries`, and what does the next merge ratchet against?"

### Cross-reference with code

When the user states how something works, verify against the code in the relevant module (`src/cli/`, `src/core/`, `src/claude/`, `src/adapters/`). Surface contradictions: "`merge-gate.service.ts` refuses on a flagged stage unless `--accept-debt`, but you said flagged stages are advisory. Which is right?"

### Update the existing docs inline

When something resolves, update it in place. Capture as it happens; don't batch.

- **New persisted noun?** Add the table/column in `src/core/db.client.ts` and name it in the decision that introduces it.
- **Naming stem or role suffix decision?** Update `docs/conventions/naming.md`.
- **Design narrative has drifted from reality?** Update the relevant `docs/0N` doc.
- **Hard-to-reverse choice with non-obvious rejected alternatives?** Add a numbered decision.

Do not create a parallel `CONTEXT.md`. See [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md) for the underlying glossary discipline if you need a reminder of what a good entry looks like.

### Offer decision entries sparingly

Only offer a numbered decision when all three are true:

1. **Hard to reverse**: the cost of changing your mind later is meaningful
2. **Surprising without context**: a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off**: there were genuine alternatives and one was picked for specific reasons

If any of the three is missing, skip it. See [DECISION-FORMAT.md](./DECISION-FORMAT.md) for the bar, the entry template, and how to claim a number safely.
