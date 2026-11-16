#!/usr/bin/env bash
# Build dist/ from scratch, so no module of a deleted source survives in it.
#   pnpm build   ->  type-checks, compiles into a fresh directory, then swaps it in for dist/
# The installed pup is a symlink into dist/: a failed build leaves the previous dist/ in place.
# Each run stages in its own ./.pup-build.XXXXXX, so concurrent builds never delete each other's.
set -euo pipefail

cd "$(dirname "$0")/.."

[ ! -L node_modules ] || { echo "build: node_modules is a symlink; refusing to build" >&2; exit 1; }
TSC=node_modules/.bin/tsc

STAGE=$(mktemp -d ./.pup-build.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT
[ ! -L "$STAGE" ] || { echo "build: $STAGE is a symlink; refusing to build" >&2; exit 1; }

"$TSC" --noEmit
"$TSC" -p tsconfig.build.json --outDir "$STAGE/dist"
[ -f "$STAGE/dist/cli/index.js" ] || { echo "build: $STAGE/dist/cli/index.js was not emitted" >&2; exit 1; }
chmod +x "$STAGE/dist/cli/index.js"

# The swap holds a mkdir lock, so two builds never interleave their moves of dist/.
LOCK=.pup-build.lock
LOCKED=0
for _ in $(seq 100); do
  if mkdir "$LOCK" 2>/dev/null; then LOCKED=1; break; fi
  sleep 0.1
done
[ "$LOCKED" = 1 ] || { echo "build: another build holds $LOCK; remove it if no build is running" >&2; exit 1; }
trap 'rm -rf "$STAGE"; rmdir "$LOCK"' EXIT
[ ! -e dist ] || mv dist "$STAGE/old"
if ! mv "$STAGE/dist" dist; then
  [ ! -e "$STAGE/old" ] || mv "$STAGE/old" dist
  echo "build: could not move the new build into dist/; the previous dist/ is kept" >&2
  exit 1
fi
