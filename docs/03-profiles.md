# Profile compiler

Compiles three layers into a session's worktree: `CLAUDE.md`, `.claude/settings.json`, `.claude/agents/`, `.claude/skills/`, MCP config. The compiled output is hashed and recorded on the session. Hand-editing worktree config is blocked by the scope hook.

## Layers

1. Base — always applied, non-removable.
   - Safety hooks: scope enforcement (PreToolUse), event logging (PostToolUse), format-on-write.
   - Core conventions: correct > simple > readable > fast; no abstraction until third use; no new dependency without approval; no unused config options.
   - Reviewer subagent (invoked by the gate before human review).
   - Budget: under 1500 tokens.

2. Role — reusable, e.g. `backend`, `refactor`, `test-writer`, `docs`.
   - Skills allowlist, role subagents (e.g. `test-runner` for backend, `dead-code-checker` for refactor), role conventions.

3. Task — generated per task at `pup new`.
   - The spec contract: goal, scope-in, scope-out, acceptance criteria.
   - Knowledge slice: code-map subgraph for in-scope modules, open ledger entries on touched files, recent decision records for the area.

## Schema (stored as YAML in `~/.pupitre/<id>/profiles/`)

```yaml
name: backend
extends: base
conventions: |
  ...
skills: [api-testing, sql-review]
subagents: [test-runner]
hooks: []            # additive only; base hooks cannot be removed
mcp: []
context_budget: 6000  # hard cap for the compiled result, tokens
```

## Code graph (decision 51)

Present only when `codegraph` is on pup's PATH; absent, a session launches normally with none.

- `mcp.json` is compiled beside `settings.json` — one stdio server `--path`-pinned to the
  session's worktree — and launched as `claude --mcp-config <compiled>/mcp.json`. No
  `--strict-mcp-config`: added to the operator's MCP servers, not swapped for them (decision 9).
- Compiled, not written beside the profile, so the binary serving the graph is recorded in the
  profile hash at compile time. That is attribution, not detection: nothing re-reads the compiled
  dir to verify it (decision 46's ceiling).
- A short `## Code graph` context section points the session at `codegraph_explore` before it
  reads files; the server sends its own usage instructions on connect.
- **One graph per worktree**: the index lives in `.worktrees/<id>/.codegraph`, built from that
  worktree at launch, never shared and never the main checkout's. `.codegraph/` is untracked, so
  it goes once into the repo's shared `info/exclude` (the common dir covers every worktree).
- A worktree that will not index gets no config at all — no graph, never the wrong graph.

## Context budget rules

- Compiler prints the token count of the compiled context and refuses to compile past the cap.
- Pointers over payloads: the code-map slice is an index ("retry logic: core/net/retry.ts"), never file contents. The agent reads files on demand.
- Task specs longer than one screen are a smell: split the task.

## Fleet management

- Profile edits bump a version. `pup profile stale` lists running sessions behind current; restart or `pup steer` them.
- Every gate report and decision record carries the profile hash, so bad output is attributable to profile vs task and fixed once for the fleet.
