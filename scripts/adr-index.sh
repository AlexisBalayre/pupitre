#!/bin/bash
# Regenerate the one-line-per-decision index in docs/adr/README.md (number, title, status).
#   bash scripts/adr-index.sh           rewrite the index between the markers
#   bash scripts/adr-index.sh --check   exit 1 when the index is stale (run by `pnpm lint`)
# Nobody edits the index by hand: add or change a decision file, then run this.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
ADR_DIR=${ADR_DIR:-docs/adr}
README=$ADR_DIR/README.md
BEGIN='<!-- adr-index:begin -->'
END='<!-- adr-index:end -->'

index() {
  for f in "$ADR_DIR"/[0-9][0-9][0-9][0-9]-*.md; do
    title=$(sed -n '1s/^# //p' "$f")
    status=$(sed -n 's/^- Status: //p' "$f" | head -n 1)
    if [ -z "$title" ] || [ -z "$status" ]; then
      echo "$f needs a '# ' title on line 1 and a '- Status:' line." >&2
      return 1
    fi
    printf -- '- [%s](%s) (%s)\n' "$title" "$(basename "$f")" "$status"
  done
}

for marker in "$BEGIN" "$END"; do
  if ! grep -qxF "$marker" "$README"; then
    echo "$README lacks the marker $marker." >&2
    exit 1
  fi
done

# The sandboxed merge gate allows no temp files, so the index travels through the environment
# and the check compares strings.
IDX=$(index)

render() {
  IDX=$IDX awk -v begin="$BEGIN" -v end="$END" '
    $0 == begin { print; print ENVIRON["IDX"]; skip = 1; next }
    $0 == end { skip = 0 }
    !skip { print }
  ' "$README"
}

# The canonical file ends in exactly one newline; the trailing x keeps $(...) from stripping it.
canonical() {
  out=$(render)
  printf '%s\nx' "$out"
}

if [ "${1:-}" = "--check" ]; then
  if [ "$(canonical)" != "$(cat "$README"; echo x)" ]; then
    echo "$README index is stale: run 'bash scripts/adr-index.sh'." >&2
    exit 1
  fi
else
  out=$(canonical)
  printf '%s' "${out%x}" > "$README"
fi
