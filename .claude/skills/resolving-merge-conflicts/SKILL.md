---
name: resolving-merge-conflicts
description: Resolve an in-progress git merge or rebase conflict. Use when a merge, rebase, or cherry-pick stops on conflicts.
---

1. **See the current state** of the merge/rebase. Check `git status`, the git history of both sides, and the conflicting files.

1. **See the current state** of the merge/rebase: `git status`, the history of both sides, and the conflicting files.

2. **Find the primary sources** for each conflict. Understand deeply why each change was made and what the original intent was. Read the commit messages and the PRs (`gh pr view`); PR bodies cite the decision they land as, so read that entry in `docs/09-decisions.md` when the intent is still unclear.

3. **Resolve each hunk.** Preserve both intents where possible. Where incompatible, pick the one matching the merge's stated goal and note the trade-off. Do **not** invent new behaviour. Always resolve; never `--abort`.

4. **Regenerate, don't hand-merge.** Conflict markers in generated files are never resolved by hand:
   - `pnpm-lock.yaml`: take either side wholesale, then re-run `pnpm install` to regenerate.
   - Any other generated artifact: re-run its generator against the merged sources; never edit the output.

   `src/core/db.client.ts` is **not** generated — its `SCHEMA` and `MIGRATIONS` are hand-written. Resolve it as source: keep both sides' `CREATE TABLE`s and both sides' `MIGRATIONS` entries, since each entry is guarded by its own `table_info` check and is idempotent.

5. **Run the tests** (`pnpm test`) and fix anything the merge broke (formatting and typechecking run automatically via the Stop hook). The pre-commit hook lints, typechecks, and tests the whole repo; failures that already exist on the base branch are not the merge's fault, and `--no-verify` is acceptable only for those.

6. **Finish the merge/rebase.** Stage everything and commit. If rebasing, continue the rebase process (`git rebase --continue`) until all commits are rebased.
