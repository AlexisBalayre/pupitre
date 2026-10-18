#!/usr/bin/env bash
# SessionStart(compact) hook: re-injects the live state a compaction summary
# tends to lose or leave stale: the session's branch, every worktree, the open
# PRs and whether the CI review covers their head.
# Read fresh here, after compaction, because SessionStart stdout is added to
# Claude's context while PreCompact output never reaches the summary.
# Every probe is best-effort: a missing tool or a failed call drops its line.
# No git call here reads an index or worktree file: git status would run a
# clean filter a pup worker can plant in the shared config (decision 50), so
# only refs, HEAD and the worktree list are read.
set -uo pipefail

cat >/dev/null
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
SELF=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0

BRANCH=$(git branch --show-current 2>/dev/null)
echo "Live state after compaction (read now; trust it over the summary):"
echo "- checkout: $SELF on ${BRANCH:-a detached HEAD}"

# Another session names its worktree's path and branch, and a fork names its PR
# branch, so anything outside a plain path's characters is masked before it
# lands in this session's context. The gh filter below masks the same set.
safe() { printf '%s' "$1" | LC_ALL=C tr -c 'A-Za-z0-9._/() -' '?'; }
echo "- other worktrees (path, branch):"
git worktree list --porcelain 2>/dev/null |
  awk '/^worktree /{p=$0; sub(/^worktree /, "", p)}
       /^branch /{b=$0; sub(/^branch refs\/heads\//, "", b); print p"\t"b}
       /^detached/{print p"\t(detached)"}' |
  while IFS=$'\t' read -r path branch; do
    [ "$path" = "$SELF" ] || printf '    %s  %s\n' "$(safe "$path")" "$(safe "$branch")"
  done

# The claude-review commit status sits on the PR's head commit, so "none" means
# the CI review has not covered the current head.
if command -v gh >/dev/null 2>&1; then
  PRS=$(gh pr list --state open --limit 20 --json number,headRefName,headRefOid,statusCheckRollup \
    --jq '.[] | "    #\(.number) \(.headRefName | gsub("[^A-Za-z0-9._/() -]"; "?")) @\(.headRefOid[:7]) review: \(([.statusCheckRollup[] | select(.context == "claude-review") | .state][0]) // "none")"' 2>/dev/null)
  [ -n "$PRS" ] && printf -- '- open PRs:\n%s\n' "$PRS"
fi
exit 0
