#!/bin/bash
# PreToolUse(Edit|Write) hook — blocks manual edits to generated files
# (GENERATED_PATHS_REGEX in .claude/project.env; unset = no check).

set -o pipefail

[ -f "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/lib/project-env.sh" ] && . "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/lib/project-env.sh"
command -v load_project_env >/dev/null && load_project_env "${CLAUDE_PROJECT_DIR:-.}/.claude/project.env"
[ -z "${GENERATED_PATHS_REGEX:-}" ] && exit 0

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE_PATH" ] && exit 0

# Case-insensitive: the filesystem is, so PNPM-LOCK.yaml would otherwise reach the same file.
if echo "$FILE_PATH" | grep -qiE "$GENERATED_PATHS_REGEX"; then
  echo "BLOCKED: $FILE_PATH is generated. Edit its source and rerun the generator instead." >&2
  exit 2
fi

exit 0
