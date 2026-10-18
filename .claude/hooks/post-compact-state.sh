#!/usr/bin/env bash
# SessionStart(compact) hook: re-injects the live state a compaction summary
# tends to lose or leave stale: the session's branch and changes, every
# worktree, the open PRs and whether the CI review covers their head.
# Read fresh here, after compaction, because SessionStart stdout is added to
# Claude's context while PreCompact output never reaches the summary.
# Every probe is best-effort: a missing tool or a failed call drops its line.
set -uo pipefail

cat >/dev/null
# The session's own checkout is the only tree git status runs in: a pup worker's
# worktree can plant an fsmonitor or a clean filter that a status there would
# run as this session (decision 50), and neither the hook's .cwd (the console may
# have cd'd into one) nor a branch name (a worker can rename its branch) proves
# a tree is not a worker's.
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
SELF=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0

BRANCH=$(git branch --show-current 2>/dev/null)
echo "Live state after compaction (read now; trust it over the summary):"
echo "- checkout: $SELF on ${BRANCH:-a detached HEAD}"
# --no-optional-locks: a plain status may take index.lock to refresh the index,
# failing a commit a parallel session runs in that worktree at the same moment.
CHANGES=$(git -c core.fsmonitor= --no-optional-locks status --short 2>/dev/null | head -20)
[ -n "$CHANGES" ] && printf -- '- uncommitted here:\n%s\n' "$(printf '%s\n' "$CHANGES" | sed 's/^/    /')"

# Another session names its worktree's path and branch, and both land in this
# session's context, so anything outside a plain path's characters is masked.
safe() { printf '%s' "$1" | LC_ALL=C tr -c 'A-Za-z0-9._/() -' '?'; }
echo "- other worktrees (path, branch):"
git worktree list --porcelain 2>/dev/null |
  awk '/^worktree /{p=substr($0,10)} /^branch /{print p"\t"substr($0,19)} /^detached/{print p"\t(detached)"}' |
  while IFS=$'\t' read -r path branch; do
    [ "$path" = "$SELF" ] || printf '    %s  %s\n' "$(safe "$path")" "$(safe "$branch")"
  done

# The claude-review commit status sits on the PR's head commit, so "none" means
# the CI review has not covered the current head.
if command -v gh >/dev/null 2>&1; then
  PRS=$(gh pr list --state open --limit 20 --json number,headRefName,headRefOid,statusCheckRollup \
    --jq '.[] | "    #\(.number) \(.headRefName | gsub("[^A-Za-z0-9._/-]"; "?") | .[:60]) @\(.headRefOid[:7]) review: \(([.statusCheckRollup[] | select(.context == "claude-review") | .state][0]) // "none")"' 2>/dev/null)
  [ -n "$PRS" ] && printf -- '- open PRs:\n%s\n' "$PRS"
fi
exit 0
