# Knowledge layer

Three artefacts. All generated or one-keystroke approvals; zero standalone maintenance tasks. A stale map that agents trust is worse than no map.

## Two sources, one question (decision 51)

Structure reaches an agent two ways, and they answer different halves of "does this already exist".

- **CodeGraph, where installed.** An external binary detected like `gh` and `tmux`, never a
  dependency: a local SQLite graph of every symbol and edge, served over MCP as
  `codegraph_explore` and queried live by the agent. One graph per checkout: a session's own
  worktree, kept current by codegraph's watcher as it edits; the conductor's a private detached
  checkout of the merge target, cut fresh at `pup conductor start` and a snapshot of that moment.
  Never a live working tree it does not own — an untracked file there is writable by the sessions
  it supervises, and would come back as verbatim source (decision 51's third addendum). It
  answers at symbol granularity, with verbatim source and blast radius, which is what makes
  "reuse this" answerable rather than aspirational.
- **The adapter import scan, always.** Module granularity, computed by pup itself
  (`ts.preProcessFile` for TypeScript, an import scan for Python), and the source of both the
  compiled knowledge slice and `pup map`. It runs on every machine, needs nothing installed, and
  is what a session reads when there is no graph.

The second is not a fallback for the first yet: the slice is still cut from the import scan even
when a graph is present, because the two are compiled at different moments (the slice at compile
time, the graph at query time) and cutting the slice from `codegraph explore` would make every
launch wait on a binary that may not be there. `pup init` and `pup audit` print one
`codegraph: <version>` / `codegraph: not installed` line beside the sandbox line, so which of the
two a fleet is running on is visible before any session starts. What switching the slice would
cost is recorded in decision 51's addendum.

## Code map

- Source: adapter dependency-graph extraction (dependency-cruiser or ts-morph for TypeScript, grimp or pydeps for Python). Fallback: Claude-generated map for unsupported stacks, coarser but functional.
- Model: nodes are modules; edges are dependencies; each node carries files, exports of interest, conventions notes, recent-change count, test coverage, open ledger entries.
- Views:
  - `pup map`: text tree in the terminal.
  - `pup map --open`: interactive mind-map, single local HTML file rendered from JSON (d3 or Cytoscape). Node size by churn, colour by coverage or debt, click-through to files and decision records.
- Injection: task layer receives the compact index of in-scope nodes plus their direct neighbours. Purpose: "this already exists, reuse it".
- Refresh: regenerated for touched modules at every merge (gate stage 6); full regeneration weekly or on demand.
- Unchanged by the code graph: `pup map`, `pup map --open` and the injected slice all still come
  from the import scan above. The mind-map renders the module graph, which is the granularity it
  is a picture of; a symbol graph is not a thing to look at, it is a thing to ask.

## Decision log

- One record per merge, drafted by Claude from the diff and the task spec at gate time: what was decided, alternatives rejected, conventions applied.
- Human approves or edits in one keystroke during `pup review`.
- Queryable by module or file (`pup log core/net`). This is the answer to "why is it done this way".

## Debt ledger

Defined in 04-gates-and-debt.md. Listed here as the third artefact because it is injected into sessions and rendered on the map.

## Conventions file

- Seeded by `pup init` from observed patterns in the codebase, not from preferences: on an existing project, consistency beats ideals.
- Human-reviewed at init (mandatory step), then versioned in the base profile layer.
- Evolves via decision records: a recurring decision graduates into a convention through `pup profile edit base`.
