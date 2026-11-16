#!/usr/bin/env bash
# Build dist/ from scratch, so no module of a deleted source survives in it.
#   pnpm build   ->  type-checks, compiles into a fresh directory, then swaps it in for dist/
# The installed pup is a symlink into dist/: a failed build leaves the previous dist/ in place.
set -euo pipefail

cd "$(dirname "$0")/.."

STAGE=node_modules/.cache/pup-build
rm -rf "$STAGE"
mkdir -p "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

tsc --noEmit
tsc -p tsconfig.build.json --outDir "$STAGE/dist"
[ -f "$STAGE/dist/cli/index.js" ] || { echo "build: $STAGE/dist/cli/index.js was not emitted" >&2; exit 1; }
chmod +x "$STAGE/dist/cli/index.js"

[ ! -e dist ] || mv dist "$STAGE/old"
mv "$STAGE/dist" dist
