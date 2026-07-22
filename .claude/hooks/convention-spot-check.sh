#!/usr/bin/env bash
# Stop hook: lightweight structural convention spot-check on changed files.
# Advisory only (exit 0). Comment-quality findings are owned by comment-pruner.sh.
set -uo pipefail

# Get changed .ts/.tsx files (staged + unstaged)
CHANGED_FILES=$(git diff --name-only HEAD 2>/dev/null || true)
STAGED_FILES=$(git diff --cached --name-only 2>/dev/null || true)
ALL_FILES=$(echo -e "${CHANGED_FILES}\n${STAGED_FILES}" | sort -u | grep -E '\.(ts|tsx)$' || true)

if [ -z "$ALL_FILES" ]; then
  exit 0
fi

WARNINGS=""

while IFS= read -r file; do
  # Skip if file doesn't exist (deleted files)
  if [ ! -f "$file" ]; then
    continue
  fi

  # Check for export default
  if grep -qE '^\s*export\s+default\s' "$file" 2>/dev/null; then
    WARNINGS+="  ⚠ $file: uses 'export default' — use named exports only\n"
  fi

  # Check for inline type/interface in service or route files
  if [[ "$file" =~ \.(service|routes)\.(ts|tsx)$ ]]; then
    if grep -qE '^\s*export\s+(interface|type)\s' "$file" 2>/dev/null; then
      WARNINGS+="  ⚠ $file: exports type/interface inline — move to types/ folder\n"
    fi
  fi

  # Skip JSDoc check in tests/fixtures/mocks — these exports don't need docs.
  if [[ "$file" =~ \.(test|spec|mock|fixture)\.(ts|tsx)$ ]] || [[ "$file" =~ /__mocks__/ ]] || [[ "$file" =~ /test/ ]]; then
    continue
  fi

done <<< "$ALL_FILES"

if [ -n "$WARNINGS" ]; then
  echo "" >&2
  echo "Convention spot-check warnings:" >&2
  echo -e "$WARNINGS" >&2
  echo "These are advisory — fix before committing if possible." >&2
fi

exit 0
