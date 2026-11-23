#!/bin/bash
# Compare .claude/skills with the upstream ledger docs/skills-upstream.md.
#   skills-drift.sh                      every local file has a row, every row a file
#   skills-drift.sh <upstream-checkout>  also: verbatim rows equal upstream at the pin,
#                                        adapted rows print their changed-line count
#   skills-drift.sh --since-pin <checkout>  list upstream skill files changed since the pin
# LEDGER and SKILLS_DIR override the defaults (used by the tests).
set -uo pipefail

LEDGER=${LEDGER:-docs/skills-upstream.md}
SKILLS_DIR=${SKILLS_DIR:-.claude/skills}

since=0
[ "${1:-}" = "--since-pin" ] && { since=1; shift; }
up=${1:-}
[ "$since" -eq 1 ] && [ -z "$up" ] && { echo "--since-pin needs an upstream checkout" >&2; exit 1; }
[ -f "$LEDGER" ] || { echo "no ledger at $LEDGER" >&2; exit 1; }

pin=$(sed -n 's/^- Pinned commit: `\([0-9a-f]*\)`$/\1/p' "$LEDGER")
[ -n "$pin" ] || { echo "$LEDGER has no pinned commit" >&2; exit 1; }

if [ "$since" -eq 1 ]; then
  exec git -C "$up" diff --name-only "$pin" HEAD -- skills
fi

fail=0
bad() { echo "FAIL: $*"; fail=1; }

rows=$(awk '/^\| `/ { sub(/^\| /, ""); sub(/ \|$/, ""); n = split($0, c, / \| /); if (n == 3) print c[1] "|" c[2] "|" c[3] }' "$LEDGER" | tr -d '`')

# Every local file has a row.
while IFS= read -r f; do
  rel=${f#"$SKILLS_DIR"/}
  grep -q -F -x -e "$rel" <<<"$(cut -d'|' -f1 <<<"$rows")" || bad "$rel has no row in $LEDGER"
done < <(find "$SKILLS_DIR" -type f | sort)

while IFS='|' read -r rel path status; do
  [ -n "$rel" ] || continue
  case $status in verbatim | adapted | "local only") ;; *) bad "$rel has status '$status', not verbatim, adapted or local only"; continue ;; esac
  [ -f "$SKILLS_DIR/$rel" ] || { bad "$rel is in $LEDGER but gone"; continue; }
  if [ "$status" = adapted ]; then
    # one deviation bullet at least, under the file's own heading
    n=$(awk -v h="### \`$rel\`" '$0==h{on=1;next} /^#/{on=0} on&&/^- /{c++} END{print c+0}' "$LEDGER")
    [ "$n" -gt 0 ] || bad "$rel is adapted with no deviation line"
  fi
  [ -n "$up" ] && [ "$status" != "local only" ] || continue
  if ! git -C "$up" cat-file -e "$pin:$path" 2>/dev/null; then
    bad "$rel: $path is not upstream at the pin"
    continue
  fi
  changed=$(diff <(git -C "$up" show "$pin:$path") "$SKILLS_DIR/$rel" | grep -c '^[<>]')
  if [ "$status" = verbatim ]; then
    [ "$changed" -eq 0 ] || bad "$rel is verbatim but differs from upstream ($changed lines)"
  else
    echo "$rel: $changed changed lines"
  fi
done <<<"$rows"

exit $fail
