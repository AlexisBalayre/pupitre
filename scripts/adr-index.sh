#!/bin/bash
# Regenerate the one-line-per-decision index in docs/adr/README.md (number, title, status).
#   bash scripts/adr-index.sh           rewrite the index between the markers
#   bash scripts/adr-index.sh --check   exit 1 when the index is stale (run by `pnpm lint`)
# Nobody edits the index by hand: add or change a decision file, then run this.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
README=docs/adr/README.md
BEGIN='<!-- adr-index:begin -->'
END='<!-- adr-index:end -->'

index() {
  for f in docs/adr/[0-9][0-9][0-9][0-9]-*.md; do
    title=$(sed -n '1s/^# //p' "$f")
    status=$(sed -n 's/^- Status: //p' "$f" | head -n 1)
    printf -- '- [%s](%s) (%s)\n' "$title" "$(basename "$f")" "$status"
  done
}

# The sandboxed merge gate allows no temp files, so the index travels through the environment
# and the check compares strings.
render() {
  IDX=$(index) awk -v begin="$BEGIN" -v end="$END" '
    $0 == begin { print; print ENVIRON["IDX"]; skip = 1; next }
    $0 == end { skip = 0 }
    !skip { print }
  ' "$README"
}

if [ "${1:-}" = "--check" ]; then
  if [ "$(render)" != "$(cat "$README")" ]; then
    echo "docs/adr/README.md index is stale: run 'bash scripts/adr-index.sh'." >&2
    exit 1
  fi
else
  out=$(render)
  printf '%s\n' "$out" > "$README"
fi
