# Decision Format

Decisions live in `docs/09-decisions.md` as one numbered list entry. There is no `docs/adr/`
directory and no per-decision file: the whole log is one document, so a reader picks up the
accumulated design in one pass.

`docs/09-decisions.md` **wins over `docs/00`–`08` where they conflict**. When a decision
supersedes something a design doc still asserts, the decision entry is the fix — you do not have
to rewrite `00`–`08` to land it, though correcting an outright-wrong passage is welcome.

## Template

Entries sit under the `##` section they belong to (Runtime & control plane, Safety &
enforcement, Merge semantics, Config & profiles, Gate metrics). Numbering continues across the
whole file; the sections do not restart it.

```md
NN. **Short statement of what was decided (YYYY-MM-DD).** One to five sentences: the context,
    what was chosen, and why the obvious alternative was not. Reference the PR that landed it
    and any decision it sharpens or supersedes.
```

The bold lead is the decision itself, phrased as a claim — `**Coverage = patch coverage vs a
ratcheting baseline**`, not `**Coverage decision**`. A reader skimming only the bold text should
learn what was decided.

The date is required on new entries. Early entries predate the convention and lack one; leave
them.

## Numbering

Read the highest number on `origin/main` (after a fetch) and increment:

```sh
git show origin/main:docs/09-decisions.md | grep -oE '^[0-9]+\.' | tr -d '.' | sort -n | tail -1
```

Sort numerically — **not `| tail -1` on its own**. Entries sit under the `##` section they belong
to and the file is not in numerical order, so taking the last match in file order returns whatever
section ends the document, not the highest number. It read 34 while 35, 36 and 37 already existed,
which is precisely how two branches both claim the same number and conflict at merge time. The
local file also goes stale, hence reading `origin/main` rather than the worktree.

## When to offer a decision entry

All three of these must be true:

1. **Hard to reverse**: the cost of changing your mind later is meaningful
2. **Surprising without context**: a future reader will look at the code and wonder "why on earth did they do it this way?"
3. **The result of a real trade-off**: there were genuine alternatives and you picked one for specific reasons

If a decision is easy to reverse, skip it; you'll just reverse it. If it's not surprising, nobody will wonder why. If there was no real alternative, there's nothing to record beyond "we did the obvious thing."

### What qualifies

- **Enforcement semantics.** What a gate stage measures, what it compares against, and whether a flag refuses the merge or only warns. Decisions 13, 17 and 21 are the pattern.
- **Safety boundaries and their stated ceilings.** What the hook layer does and does *not* defend against. Recording the ceiling is the point — decision 28 is explicit that the env allowlist is hardening, not containment, so nobody later mistakes it for a sandbox.
- **Measurement definitions.** Which files a metric reaches, in which checkout, against which baseline. Decision 32 exists because the same capability reported different denominators from a worktree and from main.
- **Deliberate deviations from the obvious path.** Anything where a reasonable reader would assume the opposite. These stop the next engineer from "fixing" something that was deliberate.
- **Technology choices that carry lock-in**, cross-checked against `docs/08-roadmap.md`'s stack decisions. Not every library — the ones that would be painful to swap.
- **Rejected alternatives when the rejection is non-obvious**, and **deferred work with the reason it was deferred**, so the next session does not re-derive the trade-off.
