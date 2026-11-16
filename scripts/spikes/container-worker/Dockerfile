# Worker image for the container-per-worker spike (docs/spikes/2026-11-16-container-worker.md).
# Linux toolchain only: the repo is cloned at run time, never baked in.
# trixie, not bookworm: better-sqlite3's bundled linux prebuild needs glibc >= 2.38.
FROM node:24-trixie-slim

# python3, make, g++: pnpm runs node-gyp for better-sqlite3 (it has a binding.gyp) even though the
# package bundles prebuilds; node-gyp refuses to run without Python, make and a C++ compiler.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git tmux ca-certificates procps jq python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

ARG PNPM_VERSION=10.34.5
ARG CLAUDE_VERSION=2.1.325
RUN npm install -g "pnpm@${PNPM_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
 && npm cache clean --force

COPY entrypoint.sh /usr/local/bin/worker-entrypoint
COPY pup-shim.sh /usr/local/bin/pup
RUN chmod 755 /usr/local/bin/worker-entrypoint /usr/local/bin/pup

# node-gyp would fetch headers from nodejs.org, which the egress allowlist blocks; the image has them.
ENV npm_config_nodedir=/usr/local

USER node
WORKDIR /home/node
ENTRYPOINT ["worker-entrypoint"]
