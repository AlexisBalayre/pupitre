#!/bin/bash
# Tests for scripts/ticket-check.sh: run with `bash scripts/ticket-check.test.sh`.
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/ticket-check.sh"
fail=0

body() { # body <label> <value> [<label> <value>...]: the Markdown an issue form renders
  while [ $# -gt 0 ]; do
    printf '### %s\n\n%s\n\n' "$1" "$2"
    shift 2
  done
}

expect() { # expect <name> <0|1|2> <args...>, the body on stdin
  name=$1 want=$2
  shift 2
  out=$(bash "$SCRIPT" "$@" 2>&1)
  code=$?
  if [ "$code" -ne "$want" ]; then
    echo "FAIL: $name (exit $code, wanted $want): $out"
    fail=1
  fi
}

says() { # says <text>: the last output names it
  case $out in *"$1"*) ;; *) echo "FAIL: $name: output lacks '$1': $out"; fail=1 ;; esac
}

check_type() { # check_type <type> <vague value> <label> <value>...: a good ticket of the type
  type=$1 vague=$2
  shift 2
  fields=("$@")
  n=${#fields[@]}
  expect "a good $type ticket passes" 0 "$type" <<<"$(body "${fields[@]}")"
  [ -z "$out" ] || { echo "FAIL: a good $type ticket printed: $out"; fail=1; }
  expect "a $type ticket without ${fields[n - 2]} fails" 1 "$type" <<<"$(body "${fields[@]:0:n-2}")"
  says "missing: ${fields[n - 2]}"
  expect "a $type ticket with '$vague' as ${fields[0]} fails" 1 "$type" \
    <<<"$(body "${fields[0]}" "$vague" "${fields[@]:2}")"
  says "vague: ${fields[0]}"
}

check_type feature TBD \
  'Goal' 'An operator sees which field cost a ticket its ready label.' \
  'Acceptance criteria' '- `pup plan add` with no `--scope` exits 2 and prints "scope is required"' \
  'Out of scope' 'No change to `pup plan edit`; it keeps accepting tasks without a scope.' \
  'Affected area' 'src/core/'

check_type bug '-' \
  'Reproduction' '1. On main at 9d2ae7b8, run `pup launch t-1`' \
  'Expected against actual' 'Expected: the session starts. Actual: exits 1 with "scope collides with t-0".' \
  'Suspected area' 'src/core/task-spec.utils.ts'

check_type chore everything \
  'Scope boundary' 'Split the file in two; callers and exported names stay as they are.' \
  'Proof that behavior is unchanged' 'test/unit/core/task-spec-utils.test.ts passes without edits.' \
  'Files in scope' 'src/core/task-spec.utils.ts'

check_type docs '_No response_' \
  'What changes, or the question' 'docs/02-cli.md documents `pup session ask --option`.' \
  'Time box' '2 hours' \
  'Form of the answer' 'docs/02-cli.md'

check_type follow-up 'n/a' \
  'Source PR' '#422' \
  'Findings' '- [minor] src/core/task-spec.utils.ts:88 the error names the path, not the task' \
  'Scenarios' '`pup plan add` with a scope of `../x` prints the task id in the refusal.' \
  'Original reviewers' 'claude-review'

# Refactor and spike share the forms of chore and docs.
expect "a refactor ticket is checked as a chore" 1 refactor <<<"$(body 'Scope boundary' 'TBD')"
says "missing: Files in scope"
expect "a spike ticket is checked as docs" 1 spike <<<"$(body 'Time box' '2 hours')"
says "missing: Form of the answer"

# An empty list item is vague even under a terse field.
expect "an empty list item is vague" 1 chore <<<"$(body 'Scope boundary' 'Split the file in two.' \
  'Proof that behavior is unchanged' 'The unit tests pass unedited.' 'Files in scope' '- ')"
says "vague: Files in scope"

dir=$(mktemp -d)
body 'Time box' '2 hours' >"$dir/body.md"
expect "a body read from a file is checked" 1 docs "$dir/body.md" </dev/null
says "missing: What changes, or the question"
(cd "$dir" && bash "$SCRIPT" docs body.md >/dev/null 2>&1)
[ $? -eq 1 ] || { echo "FAIL: a relative file path was not read"; fail=1; }

expect "a file that does not exist is refused" 2 docs "$dir/none.md" </dev/null
expect "no type is refused" 2 </dev/null
expect "an unknown type is refused" 2 epic <<<"$(body 'Goal' 'x y')"
says "unknown ticket type: epic"

# The vague-word list lives only in src/core/ticket-intake.utils.ts: the script imports it.
if grep -qiE 'tbd|no response' "$SCRIPT"; then
  echo "FAIL: ticket-check.sh holds its own vague-word list; read it from ticket-intake.utils.ts"
  fail=1
fi

exit $fail
