#!/usr/bin/env bash
# Worker container entrypoint: own clone, Linux node_modules, claude in tmux.
# Env in: REPO_URL, BASE_REF, BRANCH, CLAUDE_CODE_OAUTH_TOKEN, HTTPS_PROXY, TASK_PROMPT_FILE.
set -euo pipefail
stamp() { printf '%s %s\n' "$(date -u +%H:%M:%S.%3N)" "$*" | tee -a /home/node/timeline.log; }

stamp entrypoint
if [ ! -d /home/node/work/.git ]; then
  git clone --quiet --filter=blob:none --branch "${BASE_REF:-main}" "$REPO_URL" /home/node/work
  stamp cloned
fi
cd /home/node/work
git checkout --quiet -B "$BRANCH"
git config user.name "${GIT_AUTHOR_NAME:-pup worker}"
git config user.email "${GIT_AUTHOR_EMAIL:-worker@pup.invalid}"

pnpm install --frozen-lockfile --reporter=silent
stamp installed

# claude first-run state: skip onboarding and the trust prompt for /home/node/work.
mkdir -p /home/node/.claude
cat > /home/node/.claude.json <<JSON
{"hasCompletedOnboarding":true,"bypassPermissionsModeAccepted":true,
 "projects":{"/home/node/work":{"hasTrustDialogAccepted":true}}}
JSON

tmux new-session -d -s worker -x 200 -y 50 \
  "claude --dangerously-skip-permissions --model \"\${WORKER_MODEL:-sonnet}\" \"\$(cat $TASK_PROMPT_FILE)\""
stamp tmux-started
# Keep the container alive while the tmux session lives.
while tmux has-session -t worker 2>/dev/null; do sleep 2; done
stamp tmux-exited
