# House-style PR body

Adaptive: always include `## What`; add other sections only when the section-selection table in SKILL.md says so. Lead with the operator-visible change, then implementation, then reviewer-critical info (schema changes, edge cases, deferred work).

This repo has no issue tracker. A PR anchors itself to the numbered entry in `docs/09-decisions.md` it lands, and to the PRs it follows from — not to a ticket id.

## Annotated skeleton

```md
## What

<One or two sentences: what this PR does, and the decision it lands or sharpens.
e.g. "Drops files coverage is not expected for from the coverage report. Lands as
decision 32.">

- <Concrete change, operator- or CLI-visible first.>
- <`pup <command> --flag` for new surface; name the stage/capability for gate work.>

## Why

<The evidence that this is real: the measurement that disagreed, the payload that
got through, the run that flagged. A table beats a paragraph for before/after
numbers. Say what the obvious alternative was and why it lost.>

## Migration            <!-- only if SCHEMA/MIGRATIONS in src/core/db.client.ts changed -->

`decision_records.files`: additive `TEXT NOT NULL DEFAULT '[]'`, added via a
`MIGRATIONS` entry guarded by its own `table_info` check. Stores created before
the column pick it up on next open. Backwards-compatible.

## Behaviour            <!-- only if rules/edge cases worth flagging -->

- <Gate, default, or edge case a reviewer should verify.>

## Notes                <!-- optional asides -->

- <docs-only / no code change / pre-commit green / follow-up deferred and why.>
```

Omit a `## Reviews` section. No attribution footer.

## Example: gate fix landing a decision

Title:

```
fix(gate): keep test files and other checkouts out of the coverage report
```

Body:

```md
## What

Drops files coverage is not expected for from the coverage report, in
`istanbulToCoverageReport`, using the same `isCoverageExcluded` predicate
`coverableFiles` already uses. Lands as decision 32.

Found by merging #33 and running the post-merge `pup audit` — the first time any of
the coverage decisions has run against pupitre itself. It recorded a baseline of
**32.8%** where the real figure is **68.1%**. Two defects in decision 30's
`--coverage.include` account for the gap. Both were invisible to the unit tests,
because both are about which files the glob reaches rather than what the conversion
does with them.

## Why

**Test files.** The include exists so an unloaded module appears as 0%-covered
rather than absent. It also overrides vitest's default excludes:

| Run | Files | Test files |
| :-- | ----: | ---------: |
| without `--coverage.include` | 50 | 0 |
| with `--coverage.include` | 103 | 35 |

Those 35 test files carry 1802 instrumented, wholly uncovered lines, which halves
the repo ratio. The sharper problem is `patchCoverage`: it counts any added line the
report instruments, so **every added test line counted as uncovered**. Writing tests
lowered a PR's patch coverage.

## Notes

- Ceiling: excluded files are still instrumented by vitest before pup discards them,
  so the run does more work than it needs to. Deferred.
```

Why this works: the What is one concrete sentence plus the decision number; the Why leads with the measurement that exposed the bug and quantifies it; the ceiling is stated rather than hidden.

## Example: docs-only PR

Title:

```
docs: replace another project's conventions with the rules this repo enforces
```

Body:

```md
## What

Docs-only. `docs/conventions/` and the agent manifests described a monorepo this
repo has never been; they now describe the rules the hooks actually enforce.

- **`docs/conventions/general.md`** — named exports, `types/` folder placement, and
  the `.js` extension rule that `NodeNext` makes load-bearing.
- **`docs/conventions/naming.md`** — the 25 roles `validate-file-naming.sh` accepts,
  and the banned-role rename targets.
- **`.claude/agents/*.md`** — retargeted at `docs/00`–`09` instead of a
  `docs/explanation/` tree that does not exist here.

## Why

An agent that reads a convention doc describing another repo's layout writes code
for that layout. The naming rules were the live risk: the hook rejects a file the
doc called valid.

## Notes

- No code changes; pre-commit green.
- Remaining drift tracked separately: the `.claude/skills/` tree still assumes an
  issue tracker.
```
