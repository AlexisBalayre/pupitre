#!/usr/bin/env bash
# PreToolUse(Bash) safety hook — blocks dangerous git + shell operations.
# Exit 0 = allow, Exit 2 = block with message.

set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# If there's no command, don't block.
if [ -z "$COMMAND" ]; then
  exit 0
fi

# Trunk branch is configurable via .claude/project.env (defaults to main). The
# file is parsed, never sourced: sourcing would let a checkout run code here and
# `exit 0` its way past every block below.
[ -f "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/lib/project-env.sh" ] && . "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/lib/project-env.sh"
command -v load_project_env >/dev/null && load_project_env "${CLAUDE_PROJECT_DIR:-.}/.claude/project.env"
TRUNK="${GIT_TRUNK:-main}"

# --- Destructive shell / SQL patterns -----------------------------------------

if echo "$COMMAND" | grep -qE 'rm[[:space:]]+-rf[[:space:]]|DROP[[:space:]]+TABLE'; then
  echo "BLOCKED: destructive command (rm -rf / DROP TABLE) not allowed." >&2
  exit 2
fi

# --- Destructive / irreversible git operations --------------------------------

if echo "$COMMAND" | grep -qE 'git[[:space:]]+push[[:space:]]+.*(--force\b|-f\b)'; then
  echo "BLOCKED: 'git push --force' is not allowed. Use a regular push or ask the user." >&2
  exit 2
fi

if echo "$COMMAND" | grep -qE 'git[[:space:]]+reset[[:space:]]+--hard\b'; then
  echo "BLOCKED: 'git reset --hard' is destructive. Stash or revert instead." >&2
  exit 2
fi

# --- Branch protection: never create branches on trunk, never push to trunk ---

if echo "$COMMAND" | grep -qE 'git[[:space:]]+checkout[[:space:]]+-b\b'; then
  CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "")
  if [ "$CURRENT_BRANCH" = "$TRUNK" ]; then
    echo "BLOCKED: do not use 'git checkout -b' on $TRUNK. Use 'pnpm worktree:create <name>' instead." >&2
    exit 2
  fi
fi

# Anchor on the refspec, not the substring: branch names like feature/fix-main-red
# and tag pushes must pass; only an actual trunk destination (`$TRUNK`, `src:$TRUNK`,
# `refs/heads/$TRUNK`, `:$TRUNK` deletion) is blocked. Argument tokens exclude
# command separators so a chained `&& gh pr create --base $TRUNK` can't match.
if echo "$COMMAND" | grep -qE "git[[:space:]]+push([[:space:]]+[^|&;[:space:]]+)*[[:space:]]+([^|&;[:space:]]*:)?(refs/heads/)?${TRUNK}([[:space:]]|\$|[|&;])"; then
  echo "BLOCKED: never push directly to $TRUNK. Create a PR from a feature branch." >&2
  exit 2
fi

# A bare `git push` lands on the current branch — block it while on trunk.
if echo "$COMMAND" | grep -qE 'git[[:space:]]+push[[:space:]]*$'; then
  CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "")
  if [ "$CURRENT_BRANCH" = "$TRUNK" ]; then
    echo "BLOCKED: bare 'git push' while on $TRUNK. Create a PR from a feature branch." >&2
    exit 2
  fi
fi

exit 0
