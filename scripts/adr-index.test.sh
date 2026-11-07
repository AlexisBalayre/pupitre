#!/bin/bash
# Tests for scripts/adr-index.sh: run with `bash scripts/adr-index.test.sh`.
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/adr-index.sh"
fail=0

fixture() {
  dir=$(mktemp -d)
  printf '# 0001. First\n\n- Status: accepted\n' > "$dir/0001-first.md"
}

expect() { # expect <name> <0|1> <dir> [args...]
  name=$1 want=$2 adr=$3
  shift 3
  ADR_DIR=$adr bash "$SCRIPT" "$@" >/dev/null 2>&1
  code=$?
  if [ "$code" -ne "$want" ]; then
    echo "FAIL: $name (exit $code, wanted $want)"
    fail=1
  fi
}

fixture; expect "a valid decision passes" 0 "$dir" --check

fixture
out=$(ADR_DIR=$dir bash "$SCRIPT")
[ "$out" = '- [0001. First](0001-first.md) (accepted)' ] || { echo "FAIL: index line is '$out'"; fail=1; }

fixture; printf 'no title\n\n- Status: accepted\n' > "$dir/0002-second.md"; expect "missing title fails" 1 "$dir" --check

fixture; printf '# 0002. Second\n\nbody\n' > "$dir/0002-second.md"; expect "missing status fails" 1 "$dir" --check

fixture; printf '# 0001. Other\n\n- Status: accepted\n' > "$dir/0001-other.md"; expect "a number used twice fails" 1 "$dir" --check

exit $fail
