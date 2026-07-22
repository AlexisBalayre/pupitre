# Knowledge layer

Three artefacts. All generated or one-keystroke approvals; zero standalone maintenance tasks. A stale map that agents trust is worse than no map.

## Code map

- Source: adapter dependency-graph extraction (dependency-cruiser or ts-morph for TypeScript, grimp or pydeps for Python). Fallback: Claude-generated map for unsupported stacks, coarser but functional.
- Model: nodes are modules; edges are dependencies; each node carries files, exports of interest, conventions notes, recent-change count, test coverage, open ledger entries.
- Views:
  - `pup map`: text tree in the terminal.
  - `pup map --open`: interactive mind-map, single local HTML file rendered from JSON (d3 or Cytoscape). Node size by churn, colour by coverage or debt, click-through to files and decision records.
- Injection: task layer receives the compact index of in-scope nodes plus their direct neighbours. Purpose: "this already exists, reuse it".
- Refresh: regenerated for touched modules at every merge (gate stage 6); full regeneration weekly or on demand.

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
