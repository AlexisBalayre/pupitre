#!/bin/bash
# Tests for scripts/skills-drift.sh: run with `bash scripts/skills-drift.test.sh`.
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/skills-drift.sh"
fail=0

fixture() { # an upstream repo with one commit, a skills dir and a ledger that agree
  dir=$(mktemp -d)
  mkdir -p "$dir/up/skills/a" "$dir/skills/a"
  git -C "$dir/up" init -q
  printf 'one\ntwo\n' > "$dir/up/skills/a/SKILL.md"
  git -C "$dir/up" add -A
  git -C "$dir/up" -c user.name=t -c user.email=t@t commit -q -m pin
  pin=$(git -C "$dir/up" rev-parse HEAD)
  printf 'one\ntwo\n' > "$dir/skills/a/SKILL.md"
  ledger "| \`a/SKILL.md\` | \`skills/a/SKILL.md\` | verbatim |"
}

ledger() { # ledger <rows...>
  { printf '%s\n' "- Pinned commit: \`$pin\`" '' '| Local file | Upstream path | Status |' '| --- | --- | --- |'
    printf '%s\n' "$@"; } > "$dir/ledger.md"
}

run() { LEDGER=$dir/ledger.md SKILLS_DIR=$dir/skills bash "$SCRIPT" "$@" 2>&1; }

expect() { # expect <name> <0|1> [args...]
  name=$1 want=$2
  shift 2
  out=$(run "$@")
  code=$?
  if [ "$code" -ne "$want" ]; then
    echo "FAIL: $name (exit $code, wanted $want)"
    fail=1
  fi
}

fixture; expect "a verbatim file equal to upstream passes" 0 "$dir/up"

fixture; printf 'x\n' > "$dir/skills/a/NEW.md"
expect "a file with no row fails" 1
case $out in *a/NEW.md*) ;; *) echo "FAIL: missing row not named: $out"; fail=1 ;; esac

fixture; rm "$dir/skills/a/SKILL.md"
expect "a row whose file is gone fails" 1
case $out in *a/SKILL.md*) ;; *) echo "FAIL: gone file not named: $out"; fail=1 ;; esac

fixture; printf 'one\nchanged\n' > "$dir/skills/a/SKILL.md"
expect "a verbatim file that differs fails" 1 "$dir/up"

fixture; printf 'one\nchanged\n' > "$dir/skills/a/SKILL.md"
ledger "| \`a/SKILL.md\` | \`skills/a/SKILL.md\` | adapted |" '' '### `a/SKILL.md`' '' '- pup owns this: a reason'
expect "an adapted file prints its count" 0 "$dir/up"
case $out in *"a/SKILL.md: 2 changed lines"*) ;; *) echo "FAIL: count is '$out'"; fail=1 ;; esac

fixture; ledger "| \`a/SKILL.md\` | \`skills/a/SKILL.md\` | adapted |"
expect "an adapted row with no deviation fails" 1

fixture; printf 'three\n' > "$dir/up/skills/a/NEW.md"
git -C "$dir/up" add -A; git -C "$dir/up" -c user.name=t -c user.email=t@t commit -q -m later
expect "since-pin lists the upstream change" 0 --since-pin "$dir/up"
[ "$out" = "skills/a/NEW.md" ] || { echo "FAIL: since-pin printed '$out'"; fail=1; }

fixture; ledger "| \`a/SKILL.md\` | \`skills/a/SKILL.md\` | Verbatim |"
expect "an unknown status fails" 1
case $out in *"a/SKILL.md has status"*) ;; *) echo "FAIL: unknown status not named: $out"; fail=1 ;; esac

fixture; run --since-pin "$dir/nowhere" >/dev/null
[ $? -ne 0 ] || { echo "FAIL: since-pin on a path that is not a repo passed"; fail=1; }

fixture; expect "no checkout still checks the rows" 0

exit $fail
