#!/bin/bash
# Tests for tool-result-size.sh: run with `bash .claude/hooks/tool-result-size.test.sh`.
set -uo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/tool-result-size.sh"
fail=0

pad() { head -c "$1" /dev/zero | tr '\0' 'x'; }

expect() { # expect <name> <warns|silent> <payload json>
  out=$(printf '%s' "$3" | bash "$HOOK")
  if [ "$2" = warns ] && [[ $out != *"characters. Next time"* ]]; then
    echo "FAIL: $1 (wanted a warning)"
    fail=1
  elif [ "$2" = silent ] && [ -n "$out" ]; then
    echo "FAIL: $1 (wanted silence, got: $out)"
    fail=1
  fi
}

bash_payload() { jq -nc --arg c "$1" --arg o "$2" '{tool_name: "Bash", tool_input: {command: $c}, tool_response: {stdout: $o, stderr: ""}}'; }

expect "small bash output is silent" silent "$(bash_payload 'ls' "$(pad 500)")"
expect "15k of plain bash output is silent" silent "$(bash_payload 'ls' "$(pad 15000)")"
expect "25k of plain bash output warns" warns "$(bash_payload 'ls' "$(pad 25000)")"
expect "15k of vitest output warns" warns "$(bash_payload 'pnpm vitest run' "$(pad 15000)")"
expect "15k of typecheck output warns" warns "$(bash_payload 'pnpm typecheck' "$(pad 15000)")"
expect "a piped test run is still a test log" warns "$(bash_payload 'pnpm test 2>&1' "$(pad 15000)")"

read_payload=$(jq -nc --arg c "$(pad 25000)" '{tool_name: "Read", tool_input: {}, tool_response: {file: {content: $c, numLines: 10}}}')
expect "a big Read warns" warns "$read_payload"

edit_payload=$(jq -nc --arg c "$(pad 30000)" '{tool_name: "Edit", tool_input: {}, tool_response: {content: $c}}')
expect "an Edit echo counts as 0" silent "$edit_payload"

expect "malformed input is silent" silent 'not json'

hint=$(printf '%s' "$(bash_payload 'ls' "$(pad 25000)")" | bash "$HOOK" | jq -r '.hookSpecificOutput.additionalContext')
[[ $hint == *"tail -n 40"* ]] || { echo "FAIL: bash hint names tail"; fail=1; }

[ "$fail" -eq 0 ] && echo "all passed"
exit "$fail"
