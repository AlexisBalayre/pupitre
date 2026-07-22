# Pupitre — overview

CLI: `pup`. A control plane for parallel Claude Code sessions: one human at the stand, many sessions playing from the same score.

## Problem

With parallel agentic coding, the bottleneck moves from writing code to human attention. Failure modes:

- Divergence: sessions solve overlapping problems differently.
- Review saturation: review slower than generation leads to blocking or rubber-stamping.
- Context drift: long sessions lose intent and codebase conventions.
- Invisible debt: unreviewed shortcuts accumulate silently.

## Goals

- Full visibility over source code: generated code map, mind-map view, decision history.
- No invisible debt: every shortcut is rejected or recorded in a ledger. Delta-based gates plus a ratchet so quality only improves.
- Senior-quality output, enforced mechanically where possible: priority order is correct > simple > readable > fast. Complexity requires a measurement.
- One config control plane: context, hooks, skills and subagents compiled per session from versioned profiles.
- Pluggable into any existing repo: audit, baseline, improve, continue. Greenfield is the degenerate case.
- Protect human throughput: risk-scored review queue, machines filter, human judges.

## Non-goals

- Not a CI system. It calls existing build and test commands; it does not replace them.
- Not a code host or PR platform. Git branches and worktrees only.
- No zero-debt promise. Debt is made visible and intentional, never forbidden absolutely.
- No absolute quality bars. All gates measure deltas against a baseline.
- v1 is single-user, single-machine. Team mode is out of scope (see roadmap).
- No manual knowledge base. Every knowledge artefact is generated or a one-keystroke approval.

## Principles

- State outside the target repo. Adoption must not require committing tool structure.
- Prevention over detection: shape agent behaviour via compiled context before catching errors at the gate.
- Everything attributable: every session runs a hashed profile version; every merge writes to the knowledge layer in the same transaction.
- Delete first: dead code and duplication removal are permanent background tasks.
