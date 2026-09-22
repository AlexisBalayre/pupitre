# Profile compiler

Compiles three layers into a session's worktree: `CLAUDE.md`, `.claude/settings.json`, `.claude/agents/`, `.claude/skills/`, MCP config. The compiled output is hashed and recorded on the session. Hand-editing worktree config is blocked by the scope hook.

## Layers

1. Base — always applied, non-removable.
   - Safety hooks: scope enforcement (PreToolUse), the Bash write re-check (around every Bash call), event logging (PostToolUse), format-on-write.
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

## Scope enforcement in a session (decisions 6, 63)

Three compiled hooks. Two of them, `scope-enforce.sh` and `bash-recheck.sh`, read the task's
scope from the sidecar files `hooks/scope-in.pat` and `hooks/scope-out.pat` (`grep -E -f`), so no
glob is ever interpolated into shell source, and both use the same order: `.claude/` first, then
scope-out, then scope-in. The third, `bash-guard.sh`, is the exception: it matches command text
for a plain write into `.claude/` and reads no scope file at all.

- `scope-enforce.sh`, PreToolUse on `Edit|Write`, refuses a path outside scope-in or inside
  scope-out before the edit happens.
- `bash-guard.sh`, PreToolUse on `Bash`, is the cheap first line. It refuses command text that
  plainly writes into `.claude/`. It reads text, so it cannot see a write made by an interpreter
  (`python3` heredocs, `node -e`, `perl`, `dd`, a redirection inside a subshell), and its pattern
  list is not meant to grow to cover them.
- `bash-recheck.sh` runs on `Bash` at PreToolUse, PostToolUse and PostToolUseFailure. A command
  that writes a file and then exits non-zero ends in PostToolUseFailure, which is why that event is
  wired too. Before the call it snapshots the dirty paths outside the scope: `git status -z
  --untracked-files=all`, plus a second pass that lists the files under `.claude/` hidden by an
  ignore rule, since the session can write that rule itself in `.git/info/exclude`. Each path gets
  one fingerprint: the `git hash-object --no-filters` blob hash for a regular file, `large-<bytes>`
  over 64 MiB, `special` for a fifo, device or symlink (never opened, since reading a fifo would
  hang the hook past its timeout), or `deleted`. Past 200 dirty paths in the worktree, in-scope
  ones counted too, it reads none of them and refuses every call until the worktree is committed
  or cleaned. The snapshot is written to `<compiled>/bash-snapshots/<tool_use_id>`.
  After the call it takes the same listing again. Any line missing from the snapshot is a file
  that was created, modified or deleted outside the scope during the call. For each one it appends
  `{"type":"scope_violation","path","reason","command","pup_session_id"}` to the session's
  `events.jsonl`, prints `SCOPE VIOLATION: <path> (<reason>) was written by: <command>` and exits 2.
  At PostToolUse, exit 2 cannot undo the write. What it does is put the refusal in front of the
  session straight away, which is decision 6's loud-backstop shape. A file that was already dirty
  before the call and has not changed is not flagged again. If git is missing or fails, or its
  scratch dir under `<compiled>/bash-snapshots/` cannot be made, the check after the call refuses.
  The check before the call never blocks it.
- The same hook runs at PostToolUse on `TaskOutput`, because a background shell or task writes
  after its own call's check has run. That read has no snapshot of its own, so every dirty path
  outside the scope is flagged again there. Claude Code also hands background output back as a
  file the session `Read`s, and that route is not re-checked: the write waits for the next Bash
  call's snapshot, which absorbs it.
- **What it cannot see:** a write that lands between one post-check and the next pre-check becomes
  part of the next snapshot's baseline and is never flagged. That covers a background shell whose
  output is read through `Read` or never, MCP write tools, and a subagent's writes unless its
  output is read through `TaskOutput`. The snapshots sit in the store, which
  a session's shell can reach, so a session that rewrites its own snapshot defeats the check for
  that call (decision 63's ceilings). The merge gate is the only check on those.
- Paths from git never reach the shell as code. `-z` names each path raw. Before NUL becomes the
  line separator, an embedded newline is mapped to `\001`, so every record is one line. Each name
  is then handled only as a quoted variable, written out with `printf '%s'`, and passed to git
  after `--`. A tool-use id is used as a file name only if it is `[A-Za-z0-9_-]`. With no usable
  id the check compares against an empty snapshot, which flags every dirty path outside the scope.

The merge gate's diff-vs-scope audit is still the authority. What the gate cannot see yet is
listed in decision 63's ceilings.

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
