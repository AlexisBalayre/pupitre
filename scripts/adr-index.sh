#!/bin/bash
# The one-line-per-decision index of docs/adr/ (number, title, status), computed from the files.
#   bash scripts/adr-index.sh           print the index
#   bash scripts/adr-index.sh --check   print nothing; exit 1 when a decision is malformed or
#                                       two share a number (run by `pnpm lint`)
# The index is not committed: a committed list is a line every decision PR adds at the same place.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
ADR_DIR=${ADR_DIR:-docs/adr}

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

duplicates=$(for f in "$ADR_DIR"/[0-9][0-9][0-9][0-9]-*.md; do basename "$f" | cut -c1-4; done | sort | uniq -d)
if [ -n "$duplicates" ]; then
  echo "Decision number used twice: $(echo "$duplicates" | tr '\n' ' ')- renumber the newer file." >&2
  exit 1
fi

if [ "${1:-}" = "--check" ]; then
  index >/dev/null
else
  index
fi
