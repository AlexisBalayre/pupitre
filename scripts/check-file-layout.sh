#!/usr/bin/env bash
# Fails when a tracked or new src/ or test/ file breaks the naming convention in
# .claude/project.env (FILE_NAMING_REGEX, FILE_NAMING_ROLE_DIRS). validate-file-naming.sh only
# sees Write calls on new files, so a file made by mv or a heredoc reaches here instead.
# Legacy violations are listed in scripts/file-layout.allow and shrink as the migration lands:
# a listed file that now conforms is an error too, so the list cannot go stale.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
. .claude/hooks/lib/project-env.sh
load_project_env .claude/project.env

ALLOW=scripts/file-layout.allow
[ -f "$ALLOW" ] || : > "$ALLOW"

violation() {
  local path="$1" name stem role parent pair
  name=$(basename "$path")
  [[ "$name" =~ $FILE_NAMING_REGEX ]] || { echo "name does not match kebab-case.role.ts"; return; }
  stem="${name%.*}"
  role="${stem##*.}"
  parent=$(basename "$(dirname "$path")")
  for pair in ${FILE_NAMING_ROLE_DIRS:-}; do
    [ "${pair%%=*}" = "$role" ] || continue
    [ "${pair#*=}" = "$parent" ] && return
    echo ".$role file must sit in a folder named '${pair#*=}/'"
    return
  done
}

fail=0
while IFS= read -r -d '' path; do
  [ -f "$path" ] || continue
  [[ "$path" =~ $FILE_NAMING_SCOPE_REGEX ]] || continue
  reason=$(violation "$path")
  listed=0
  grep -qxF -- "$path" "$ALLOW" && listed=1
  if [ -n "$reason" ] && [ "$listed" = 0 ]; then
    printf '%q: %s\n' "$path" "$reason" >&2
    fail=1
  elif [ -z "$reason" ] && [ "$listed" = 1 ]; then
    printf '%q: conforms now, remove it from %s\n' "$path" "$ALLOW" >&2
    fail=1
  fi
done < <(git ls-files -z --cached --others --exclude-standard)

while IFS= read -r path; do
  [ -z "$path" ] && continue
  [ -f "$path" ] || { printf '%q: listed in %s but gone, remove it\n' "$path" "$ALLOW" >&2; fail=1; }
done < "$ALLOW"

exit "$fail"
