# Shell Conventions

Obligations for every Bash call a session makes. `.claude/rules/shell-conventions.md` loads this
file on every request, so it stays short: each line here is itself read again by every request.

**Why:** a tool result stays in the context and every later request reads it again, and every
Bash call is one more request that reads the whole context. The 2026-11-09 `pup retro` (7 days,
329 transcripts) counted 6154 Bash results under 1k tokens, one for 64% of the 9664 requests,
carried 109.6M tokens: its biggest finding. A request read 112k context tokens on average.

**Target:** a third fewer Bash results under 1k is about 2,050 fewer requests a week, about 230M
fewer context tokens read (21% of 1,085M), and a carried figure that falls with both the call count
and the output size. Check it in the next `pup retro`: the `Bash <1k` row and each class's calls.

## Batch

- **One Bash call per step, not per command.** Chain related commands with `&&` (stop at the first
  failure) or `;` (run them all): `git add -A && git commit -q -m "…" && git log --oneline -1`.
- **Independent lookups share a call too**, with a separator where the outputs would blur:
  `git status --short; echo ---; git log --oneline -3`.
- **Don't re-check what a tool already reported.** An Edit or Write that returned no error
  succeeded, and a command that exited 0 did what it says.

## Quiet

- **Ask for the short form:** `git status --short`, `git log --oneline -5`, `git diff --stat`
  before the full diff, `git commit -q`, `git push -q`, `pnpm -s`, `ls <dir>` rather than `ls -la`.
- **Print output only on failure** when only the outcome matters:
  `out=$(cmd 2>&1) && echo ok || { echo "$out" | tail -n 40; }`.
- **Cut large output** with `tail -n 40` or a summary `grep`, as the `tool-result-size` hook says.
