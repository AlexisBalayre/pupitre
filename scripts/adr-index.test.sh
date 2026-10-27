#!/bin/bash
# Tests for scripts/adr-index.sh: run with `bash scripts/adr-index.test.sh`.
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/adr-index.sh"
fail=0

# fixture: a docs/adr directory with one valid decision and a README holding both markers
fixture() {
  dir=$(mktemp -d)
  printf '# 0001. First\n\n- Status: accepted\n' > "$dir/0001-first.md"
  printf 'intro\n<!-- adr-index:begin -->\n<!-- adr-index:end -->\n' > "$dir/README.md"
  ADR_DIR=$dir bash "$SCRIPT" || return 1
}

expect() { # expect <name> <0|1> <dir>
  ADR_DIR=$3 bash "$SCRIPT" --check 2>/dev/null
  code=$?
  if [ "$code" -ne "$2" ]; then
    echo "FAIL: $1 (exit $code, wanted $2)"
    fail=1
  fi
}

fixture; expect "fresh index passes" 0 "$dir"

fixture; printf '\n' >> "$dir/README.md"; expect "extra trailing newline fails" 1 "$dir"

fixture; printf '%s' "$(cat "$dir/README.md")" > "$dir/README.md"; expect "missing trailing newline fails" 1 "$dir"

fixture; grep -v 'adr-index:begin' "$dir/README.md" > "$dir/x"; mv "$dir/x" "$dir/README.md"
expect "missing begin marker fails" 1 "$dir"

fixture; grep -v 'adr-index:end' "$dir/README.md" > "$dir/x"; mv "$dir/x" "$dir/README.md"
expect "missing end marker fails" 1 "$dir"

fixture; printf 'no title\n\n- Status: accepted\n' > "$dir/0002-second.md"; expect "missing title fails" 1 "$dir"

fixture; printf '# 0002. Second\n\nbody\n' > "$dir/0002-second.md"; expect "missing status fails" 1 "$dir"

exit $fail
