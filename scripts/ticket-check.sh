#!/bin/bash
# Check a ticket body against its type's required fields, as intake does (decision 176).
#   ticket-check.sh <type> [file]   read the body from file, or from stdin when none is given
# The type is feature, bug, chore, refactor, docs, spike or follow-up.
# Prints each required field that is missing or vague, one per line, and exits 1 if any, 0 if
# none, 2 on bad usage or when the check cannot run.
# The fields and the vague-word list are not copied here: this runs checkTicketIntake from
# src/core/ticket-intake.utils.ts through tsx, so that file stays their only definition.
set -uo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
type=${1:-}
file=${2:-/dev/stdin}
[ -n "$type" ] || { echo "usage: ticket-check.sh <type> [file]" >&2; exit 2; }
[ "$file" = /dev/stdin ] || [ -f "$file" ] || { echo "no file at $file" >&2; exit 2; }

# The required-field map is the one list of types: an unknown type finds no fields and throws.
check='
import { readFileSync } from "node:fs";
const { checkTicketIntake } = await import(process.env.INTAKE_MODULE);
const type = process.env.TICKET_TYPE;
let result;
try {
  result = checkTicketIntake(readFileSync(0, "utf8"), type, { adrAreas: [] });
} catch {
  console.error(`unknown ticket type: ${type}`);
  process.exit(2);
}
for (const field of result.missing) console.log(`missing: ${field}`);
for (const field of result.vague) console.log(`vague: ${field}`);
'

# Opened before the cd, so a relative file path still resolves; tsx resolves from the repo root.
out=$( (cd "$root" && INTAKE_MODULE="$root/src/core/ticket-intake.utils.ts" TICKET_TYPE="$type" \
  node --import tsx --input-type=module -e "$check") <"$file") || exit 2
[ -z "$out" ] && exit 0
echo "$out"
exit 1
