#!/usr/bin/env bash
# Container-per-worker spike driver (docs/spikes/2026-11-16-container-worker.md).
#
#   run-spike.sh build                 build the worker and proxy images
#   run-spike.sh up <id> <prompt-file> start proxy + worker for session <id>
#   run-spike.sh egress <id>           probe the allowlist from inside the worker
#   run-spike.sh attach <id>           attach to the worker's tmux (detach: C-b d)
#   run-spike.sh steer <id> <text>     paste text into the worker's claude and press Enter
#   run-spike.sh events <id>           print the worker's pup-shim events
#   run-spike.sh fetch <id> <git-dir>  bundle pup/<id> out of the container, fetch it into <git-dir>
#   run-spike.sh down <id>             remove the worker, the proxy and the network
#
# The model token comes from CLAUDE_CODE_OAUTH_TOKEN in the caller's env (from
# `claude setup-token`); it is handed to `docker run` by name, never on argv.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo_url=${REPO_URL:-https://github.com/AlexisBalayre/pupitre.git}
net=pup-spike-int
proxy=pup-spike-proxy

worker() { echo "pup-worker-$1"; }

case "${1:-}" in
  build)
    docker build -q -t pup-spike-worker "$here"
    docker build -q -t pup-spike-proxy -f "$here/proxy.Dockerfile" "$here"
    ;;
  up)
    id=$2 prompt=$3
    : "${CLAUDE_CODE_OAUTH_TOKEN:?set CLAUDE_CODE_OAUTH_TOKEN}"
    docker network inspect "$net" >/dev/null 2>&1 || docker network create --internal "$net" >/dev/null
    if ! docker container inspect "$proxy" >/dev/null 2>&1; then
      docker run -d --name "$proxy" --network bridge pup-spike-proxy >/dev/null
      docker network connect "$net" "$proxy"
    fi
    docker run -d --name "$(worker "$id")" --network "$net" \
      --memory 4g --cpus 4 \
      -e CLAUDE_CODE_OAUTH_TOKEN \
      -e HTTPS_PROXY="http://$proxy:8888" -e HTTP_PROXY="http://$proxy:8888" \
      -e NO_PROXY=localhost,127.0.0.1 \
      -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
      -e REPO_URL="$repo_url" -e BASE_REF="${BASE_REF:-main}" -e BRANCH="pup/$id" \
      -e WORKER_MODEL="${WORKER_MODEL:-sonnet}" \
      -e GIT_AUTHOR_NAME -e GIT_AUTHOR_EMAIL \
      -e TASK_PROMPT_FILE=/run/task/prompt.md \
      -v "$(cd "$(dirname "$prompt")" && pwd)/$(basename "$prompt"):/run/task/prompt.md:ro" \
      pup-spike-worker
    ;;
  egress)
    c=$(worker "$2")
    for url in https://github.com/AlexisBalayre/pupitre.git https://gitlab.com/gitlab-org/gitlab.git; do
      if docker exec "$c" timeout 20 git ls-remote "$url" HEAD >/dev/null 2>&1; then echo "open    $url"; else echo "blocked $url"; fi
    done
    docker exec "$c" timeout 20 pnpm view is-number version >/dev/null 2>&1 && echo "open    registry.npmjs.org" || echo "blocked registry.npmjs.org"
    docker exec "$c" node -e '
      const s = require("net").connect({host: "1.1.1.1", port: 443, timeout: 5000});
      s.on("connect", () => { console.log("open    direct 1.1.1.1:443 (proxy bypassed)"); process.exit(0); });
      s.on("error", e => { console.log("blocked direct 1.1.1.1:443 (" + e.code + ")"); process.exit(0); });
      s.on("timeout", () => { console.log("blocked direct 1.1.1.1:443 (timeout)"); process.exit(0); });'
    docker logs "$proxy" 2>&1 | grep -E 'CONNECT|filtered|denied' | tail -8
    ;;
  attach) docker exec -it "$(worker "$2")" tmux attach -t worker ;;
  steer)
    c=$(worker "$2")
    printf '%s' "$3" | docker exec -i "$c" tmux load-buffer -
    docker exec "$c" tmux paste-buffer -p -d -t worker
    sleep 1
    docker exec "$c" tmux send-keys -t worker Enter
    ;;
  events) docker exec "$(worker "$2")" sh -c 'cat /home/node/pup-events.jsonl 2>/dev/null; cat /home/node/timeline.log' ;;
  fetch)
    id=$2 gitdir=$3 bundle=$(mktemp -d)/"$2".bundle
    docker exec "$(worker "$id")" git -C /home/node/work bundle create - "origin/${BASE_REF:-main}..pup/$id" > "$bundle"
    git -C "$gitdir" bundle verify "$bundle" >/dev/null
    git -C "$gitdir" fetch --quiet "$bundle" "pup/$id:refs/heads/pup/$id"
    echo "$bundle"
    ;;
  down)
    docker rm -f "$(worker "$2")" "$proxy" >/dev/null 2>&1 || true
    docker network rm "$net" >/dev/null 2>&1 || true
    ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
