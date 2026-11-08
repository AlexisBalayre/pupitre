# Architecture decision records

Outcome of the design review (2026-07-22) and every decision since. Where a decision contradicts
`docs/00`–`08`, the decision wins; folding the changes back into those docs is pending.

One file per decision, `NNNN-short-kebab-title.md`. The number is the decision's number, so every
"decision N" reference elsewhere stays valid. A file opens with `# NNNN. Title`, then
`- Status:` (`accepted`, or `superseded by [NNNN](...)`), then `- Amends:` lines
for the cross-references the text states (older files also carry `- Amended by:`), then the decision itself.

## Reading and writing

- Read the decisions your change touches, found through the index (`bash scripts/adr-index.sh`). Do not read the whole
  directory.
- Number a new decision by taking the highest `NNNN` on `origin/main` (after a fetch) and
  incrementing it: `git ls-tree --name-only origin/main docs/adr/ | grep -E '/[0-9]{4}-' | sort | tail -n 1`.
- Record a decision only when it is hard to reverse, surprising without context, and the result
  of a real trade-off.
- An open PR may still edit the decision it adds. Once a decision has landed, a later change
  appends an amendment section to it (dated, with the PR) or adds a new decision that links back
  through `Amends:`. It does not rewrite the landed text.
- Do not add `Amended by:` lines to a landed decision: the amending decision's `Amends:` line is
  the link, and two PRs amending one decision would conflict on its header.

## Index

`bash scripts/adr-index.sh` prints one line per decision (number, title, status), computed from the
files. It is not committed.

## Implementation notes

- Shared SQLite store in WAL mode so concurrent hook writes from multiple worktrees don't contend.
- Node >= 22, TypeScript, commander, better-sqlite3, and ink + react for `pup ui` (per 08-roadmap
  stack decision, amended by decision 52; the Node floor is Ink 7's).
