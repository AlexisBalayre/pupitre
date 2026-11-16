# 0186. Sessions get no code graph: the codegraph MCP server is removed (2026-11-13, supersedes decision 51)

- Status: accepted
- Amends: [0090](0090-pup-fix-session-hands-the-ci-review-s.md)
- Amends: [0101](0101-git-in-a-session-worktree-runs-pinned-to.md)
- Amends: [0124](0124-the-worktree-hooks-reads-run-under-a-deadline.md)

186. **Sessions get no code graph: the codegraph MCP server is removed (2026-11-13, supersedes
    decision 51).** Decision 51 gave every session, and later the conductor, a CodeGraph index of
    its own checkout, served over MCP as `codegraph_explore`, on the bet that one graph query
    beats a grep-and-read loop. Measured on 2026-11-13, the bet does not pay:
    - *A fixed charge on every worker.* The server's instructions, its tool definition and the
      kickoff's `## Code graph` paragraph cost about 2k context tokens per window. Every later
      call re-reads them, whether or not the session ever queries the graph.
    - *Large answers.* Each `codegraph_explore` answer is about 5.5k tokens: verbatim source
      for several symbols, where the session usually needed a few lines of one.
    - *Rarely used.* The median session never calls it.
    - *Dearer for the same answers.* On three exploration questions answered both ways, the
      graph took 27 turns and $0.95, and Read/Grep/Glob took 38 turns and $0.71. Fewer turns,
      but 34% more money, because each turn carried a bigger answer.
    Decision 129 already sends exploration to a cheap Explore subagent, whose reads stay out of
    the window's context. That covers the question decision 51 was answering, at a price the
    measurement favours.
    *What goes.* `codegraph.client.ts` and its test, and the indexing at launch, respawn and
    fix round. Also the compiled `mcp.json` and the `--mcp-config` launch flag, for sessions
    and the conductor alike, the `## Code graph` context section, and the `codegraph:` line of
    `pup init` and `pup audit`. The conductor's private detached checkout of the merge target
    (`~/.pupitre/<id>/conductor/checkout`) goes too. It existed only to be indexed (decision
    51's third addendum), and the conductor reads the main checkout it sits in, as its
    `## Exploring code` section already said. `ConductorCompileInput.checkoutPath` and
    `CompileInput.codegraphBinary` go with them. A window now carries no MCP config of pup's.
    The operator's own servers still load from the user config it inherits (decision 9).
    *What changes elsewhere.*
    - Decision 90's fix round: it relaunches with the recompiled settings and nothing else.
    - Decision 101: its pins for the indexer's git have no indexer left to pin. The pinned
      checkout, the pointer checks and the window's own git config stay.
    - Decision 124: the served graph's pinned git has no server left to pin. The respawn still
      checks the worktree's pointers after the kill, so a refusal can say the old window is
      gone, and the window's own check refuses it as well.
    The profile hash of every session and conductor moves once, because the compiled files
    changed.
    *Not migrated.* Several leftovers are ignored rather than cleaned up:
    - `.codegraph/` directories in existing worktrees.
    - The `/.codegraph/` line decision 51 appended to the shared `info/exclude`.
    - A conductor checkout cut before this, with its worktree registration.
    Each is inert: nothing reads them, the exclude line hides only that one root directory, and
    `git worktree remove` on the checkout clears the last one whenever the operator wants.
    *Out of reach of this change.* A contributor's own Claude Code may still run codegraph on
    this repo. That is their tooling (`CLAUDE.md`, `scripts/worktree-create.sh`, the
    `.claude/` examples), not pup's, and a pup session no longer knows about it. Two test
    helpers that only the removed tests used, `stubCodegraph` in
    `test/helpers/cli-index.mock.ts` and `commandScopeConfig` in
    `test/helpers/profile-compiler.mock.ts`, sit outside this task's scope. They are left for
    the next change that touches `test/helpers/`.
    *Revisit if* a graph tool can be offered without a fixed per-window charge (loaded only when
    asked for), and a measurement on real tasks shows it cheaper than the Explore subagent for
    the same answers.
