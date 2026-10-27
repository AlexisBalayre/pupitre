# 0107. One file per decision under docs/adr/, numbered as before, with a generated index (2026-10-27)

- Status: accepted
- Amends: [0001](0001-sessions-are-interactive-claude-in-tmux-panes.md)

107. **One file per decision under `docs/adr/`, numbered as before, with a generated index
    (2026-10-27).**
    `docs/09-decisions.md` reached 6,300 lines (~110k tokens). 86 of 111 planned tasks scoped it,
    so parallel workers conflicted on one file, and every reader loaded all of it. Each numbered
    decision now lives in `docs/adr/NNNN-short-kebab-title.md` under its existing number, so every
    "decision N" reference stays valid. A file opens with `# NNNN. Title`, `- Status:` and the
    `- Amends:` / `- Amended by:` lines its text states; the body was moved byte for byte.
    `docs/adr/README.md` holds the preamble, the rules for writing a decision and an index of
    number, title and status that `scripts/adr-index.sh` generates. `pnpm lint` runs
    `scripts/adr-index.sh --check` and fails when the index is stale, so no worker edits it by hand.
    An open PR may still edit the decision it adds; once a decision has landed, a later change
    appends an amendment section or adds a new decision that links back through `Amends:`.
    Readers read the decisions their change touches, found through the index, not the directory.
    The `##` section headings of the old file are dropped; the index is the map.
    *Departure from the template:* the template keeps `docs/adr/`, and pupitre had departed from
    it with one log. Splitting returns to it, with the numbering and the "wins over `docs/00`–`08`"
    rule kept.
