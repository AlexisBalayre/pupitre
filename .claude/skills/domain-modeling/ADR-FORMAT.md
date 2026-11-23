# ADR Format

Decisions live in `docs/adr/`, one file each: `NNNN-short-kebab-title.md`. The number is the
decision's number, so every "decision N" reference elsewhere stays valid. `docs/adr/README.md`
holds the rules; this file is the short version for writing one.

A decision **wins over `docs/00`–`08` where they conflict**. When a decision supersedes something
a design doc still asserts, the decision is the fix: you do not have to rewrite `00`–`08` to land
it, though correcting an outright-wrong passage is welcome.

## Template

```md
# NNNN. Short statement of what was decided (YYYY-MM-DD)

- Status: accepted
- Amends: [MMMM](MMMM-the-amended-file.md)

N. **Short statement of what was decided (YYYY-MM-DD).** One to five sentences: the context,
    what was chosen, and why the obvious alternative was not.
```

- Line 1 is `# NNNN. Title` with the four-digit padded number; the bold lead restates it unpadded
  (`N.`), as `# 0146.` is followed by `146. **...**`. The title is the decision phrased as a claim
  (`Coverage is patch coverage against a ratcheting baseline`, not `Coverage decision`). A reader
  skimming only titles should learn what was decided.
- `- Status:` is `accepted`, or `superseded by [NNNN](...)`. `bash scripts/adr-index.sh --check`
  (part of `pnpm lint`) fails on a file with no title or no status, and on a number used twice.
- One `- Amends:` line per decision the text amends or sharpens. Never add `Amended by:` to a
  landed decision: the amending decision's `Amends:` line is the link.
- The date is in the title and in the bold lead.
- A landed decision is not rewritten. A later change appends a dated amendment section to it (with
  the PR) or adds a new decision that links back through `Amends:`. An open PR may still edit the
  decision it adds.

## Numbering

Take the highest `NNNN` on `origin/main`, after a fetch, and add one:

```sh
git fetch origin && git ls-tree --name-only origin/main docs/adr/ | grep -E '/[0-9]{4}-' | sort | tail -n 1
```

Read `origin/main`, not the worktree: the worktree goes stale, and two branches that both claim the
next number conflict at merge. Find the decisions your change touches with
`bash scripts/adr-index.sh`; do not read the whole directory.

## When to offer a decision

All three of these must be true:

1. **Hard to reverse**: the cost of changing your mind later is meaningful
2. **Surprising without context**: a future reader will look at the code and wonder "why on earth did they do it this way?"
3. **The result of a real trade-off**: there were genuine alternatives and you picked one for specific reasons

If a decision is easy to reverse, skip it: you'll just reverse it. If it's not surprising, nobody will wonder why. If there was no real alternative, there's nothing to record beyond "we did the obvious thing."

### What qualifies

- **Enforcement semantics.** What a gate stage measures, what it compares against, and whether a flag refuses the merge or only warns.
- **Safety boundaries and their stated ceilings.** What the hook layer does and does *not* defend against. Recording the ceiling is the point.
- **Measurement definitions.** Which files a metric reaches, in which checkout, against which baseline.
- **Deliberate deviations from the obvious path.** Anything where a reasonable reader would assume the opposite. These stop the next engineer from "fixing" something that was deliberate.
- **Technology choices that carry lock-in**, cross-checked against `docs/08-roadmap.md`'s stack decisions. Not every library, only the ones that would be painful to swap.
- **Rejected alternatives when the rejection is non-obvious**, and **deferred work with the reason it was deferred**, so the next session does not re-derive the trade-off.
