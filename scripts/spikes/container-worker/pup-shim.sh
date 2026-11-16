#!/usr/bin/env bash
# Stand-in for `pup session …` inside the worker container. The container has no
# ~/.pupitre and no route to the host daemon, so each call appends one JSON line to
# /home/node/pup-events.jsonl; the host reads it with `docker exec` (see run-spike.sh).
set -euo pipefail
events=/home/node/pup-events.jsonl
emit() { jq -cn --arg kind "$1" --arg text "$2" '{ts: (now|todate), kind: $kind, text: $text}' >> "$events"; }

[ "${1:-}" = session ] || { echo "pup (container shim): only 'pup session …' is available" >&2; exit 2; }
case "${2:-}" in
  done) emit done "${3:-}"; echo "recorded: done" ;;
  ask)  emit ask "${3:-}"; echo "recorded: ask; the operator answers with a steer" ;;
  test) shift 2; emit test "$*"; cd /home/node/work && exec pnpm test "$@" ;;
  *) echo "pup (container shim): unsupported: session ${2:-}" >&2; exit 2 ;;
esac
