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

## Project brief (decision 57)

The operator's direction for the project, in free Markdown at `~/.pupitre/<id>/brief.md` and
edited with `pup brief edit`. It is not a layer: one file per project, not per role or task, and
it is never merged into one. A project with no brief compiles exactly as it did before briefs
existed — no section, no change to any hash.

- Pup reads no meaning out of it. The template's three headings — **Destination**, **Constraints**,
  **Priorities** — are the only structure it knows, and they exist so the file can be split in one
  place. Headings inside a fenced code block are text, and `## Constraints ##` is the same heading
  as `## Constraints`. Rename them, or write one in some other form, and the brief simply carries
  less — silently; `pup brief show` is where the operator sees what pup sees.
- A **session** is given Destination and Constraints, demoted one level under a `## Project brief`
  section: where the project is going and what it may not do are the operator's direction to
  whoever writes the code. The Priorities are not sent — what to do first is the conductor's call,
  and a session reading it would be invited to re-plan its own task. A brief still on its template
  carries nothing, so no section is emitted.
- The **conductor** is given the file whole, Priorities included, with one line saying which half
  the sessions it launches will have seen.
- The section is compiled **last** in a session's context — below the goal, the scope, the
  acceptance criteria, the conventions and the session protocol — and below the Role in the
  conductor's, and pup writes the line that introduces it: reference material from the operator,
  not a task, granting no permission, widening no scope and changing no rule in the document,
  which wins where they differ. The brief is a file in the store, which a session's shell can
  reach, so position and framing are what bound what a session could put there; the `pup brief`
  guard covers the verbs, not the file (decision 57's ceiling).
- Every reader goes through `readBrief`, which strips control characters (keeping newline and tab)
  and caps the brief at 8000 characters, refusing past it with `InvalidProfileError` naming the
  path. All three launch paths answer that refusal in one line.
- The **whole** brief is hashed into a session's profile hash, beside the compiled files and the
  user-config snapshot — not just the slice that reached `context.md`. An operator who rewrote
  only the Priorities changed the direction the session was launched under. A brief saved on its
  untouched template also moves the hash while adding no section: the file is there now, and the
  hash records the file. The hash is *recorded for* config drift and `pup profile stale`, neither
  of which exists yet — `config_drift` has no emitter and `pup profile stale` is not implemented,
  so nothing reads it today.
- The brief is read **at compile time**, which is what makes an edit land at the next launch and
  the next conductor start and never in a window already open. `pup brief edit` names the
  conductor and sessions still running on the brief as it was.

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
