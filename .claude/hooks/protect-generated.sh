#!/bin/bash
# Protect generated files from manual edits
# Runs as PreToolUse hook on Edit/Write tool calls

set -o pipefail

# The tool input is passed via stdin as JSON
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | grep -o '"file_path":"[^"]*"' | head -1 | sed 's/"file_path":"//;s/"$//')

# If we can't extract the file path, allow it
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Block: the pnpm lockfile — the only generated file this repo commits.
if echo "$FILE_PATH" | grep -qE '(^|/)pnpm-lock\.yaml$'; then
  echo "BLOCKED: pnpm-lock.yaml is generated. Change 'dependencies' in package.json and run 'pnpm install' instead." >&2
  exit 2
fi

exit 0
