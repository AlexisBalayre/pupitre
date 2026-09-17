# Hook catalog

Hooks are deterministic shell scripts wired in [`settings.json`](../settings.json) that run on
lifecycle events — zero LLM cost, zero context, no hallucination. You never invoke them; they
fire automatically. Exit code `2` blocks the operation, `0` allows it.

Stack-specific values (commands, generated paths, naming pattern, trunk) come from
[`.claude/project.env`](../project.env), read through [`lib/project-env.sh`](lib/project-env.sh):
`KEY=value` lines for a fixed set of keys, parsed and never sourced, so a checkout cannot run code
inside a hook. An empty value turns the check off. `scripts/pre-commit` reads the main checkout's
copy, never the worktree being committed.

| Hook | Fires on | What it does |
| :--- | :------- | :----------- |
| `quality-checks.sh` | `Stop` | When `.ts/.tsx` files (`SOURCE_EXTENSIONS`) are dirty: `FORMAT_FIX_CMD` (Biome auto-fix) then `LINT_CMD` (Biome check) on the dirty files, then a whole-repo `TYPECHECK_CMD` (`pnpm typecheck`). Blocks (exit 2) on any failure. Tests are deliberately not run here: `scripts/pre-commit` runs `TEST_CMD`, the full Vitest suite. |
| `convention-spot-check.sh` | `Stop` | Runs the checks in [`.claude/spot-checks.tsv`](../spot-checks.tsv) (path regex, forbidden content regex, message) over the session's changed and untracked files; here, an exported type/interface inlined in a `*.service.ts` / `*.routes.ts`. Blocks once (exit 2) so findings actually reach the model (exit-0 output never does), then stays silent on the `stop_hook_active` re-run so a heuristic misfire cannot loop. Named exports are Biome's (`noDefaultExport` in [`biome.json`](../../biome.json)); comment quality is `comment-pruner.sh`'s. |
| `comment-pruner.sh` | `Stop` | When the session added net-new comments (hashed against a memo of already-adjudicated ones): exits 2 so the main loop dispatches the `comment-pruner` subagent over the touched files, then seals the memo. A cheap pre-filter — a response that adds no comment pays nothing. |
| `git-safety.sh` | `PreToolUse(Bash)` | Blocks `rm -rf`, `DROP TABLE`, `git push --force`, `git reset --hard`, `checkout -b` on the trunk, and pushes to the trunk. Trunk name from `GIT_TRUNK` (default `main`). |
| `protect-generated.sh` | `PreToolUse(Edit\|Write)` | Blocks edits to paths matching `GENERATED_PATHS_REGEX`: `pnpm-lock.yaml`, the only generated file this repo commits (change `package.json` and run `pnpm install` instead). |
| `validate-file-naming.sh` | `PreToolUse(Write)` | Blocks new files under `FILE_NAMING_SCOPE_REGEX` (`src/**/*.ts(x)`) whose name doesn't match `FILE_NAMING_REGEX` (`kebab-case.role.ts`, 25 roles; taxonomy in `docs/conventions/naming.md`), showing `FILE_NAMING_HINT`. Overwrites of existing files and paths outside `$CLAUDE_PROJECT_DIR` pass, so legacy names and sibling repos are not held to the pattern. |
| `pre-compact-preserve.sh` | `PreCompact` | Injects must-preserve context (current branch + worktree path, modified files, test results) so it survives compaction. |

**Configure / disable:** edit the entry under `hooks` in `settings.json`. Scripts must stay
executable (`chmod +x`). To add a hook, see [`.claude/README.md`](../README.md) ("New hook").
