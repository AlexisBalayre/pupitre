# Spike: one worker session in a container (2026-11-16)

The operator decided on 2026-11-13 to run one container per worker, not a VM.
Network egress goes through an allowlist: the model API, the npm registry and
GitHub read for fetch. The container gets its own clone, Linux
`node_modules`, tmux and a model token. It gets no gh credentials, no
`~/.pupitre` and no main checkout. This spike ran one real backlog task that
way, from kickoff to a commit the host fetched and gated. It feeds the ADR
that will supersede the "real containment … deferred" paragraph of
decision 28. No ADR is written here.

**Verdict: it works, and it is fast and light.** About 5 s from `docker run`
to claude in tmux. Memory was ~0.3 GiB at rest and ~1.1 GiB while tests ran.
The worker finished the task in 2 min 16 s. Five things bit:

- **The gate's test suite is not Linux-clean.** 508 of 3938 tests fail in the
  container, for environment reasons.
- **Passing a token conflicts with decision 12.** That decision says pup
  never handles tokens.
- **A host-name allowlist does not mean "read".** Allowing github.com allows
  pushing to any repo.
- **The container bypasses pup's machine-wide test slots.**
- **`pup session …` and the session hooks have no path into the
  container.**

## What was built (`scripts/spikes/container-worker/`)

- `Dockerfile`: `node:24-trixie-slim` with git, tmux, jq, python3, make, g++,
  pnpm 10.34.5 and `@anthropic-ai/claude-code` 2.1.325. Image size 1.46 GB;
  building it takes 30–40 s. The repo is not baked in.
- `entrypoint.sh`: makes a blobless clone of `main` from GitHub, checks out
  `pup/<id>` and runs `pnpm install --frozen-lockfile`. It then seeds
  `~/.claude.json` (onboarding done, trust accepted for `/home/node/work`)
  and starts `claude --dangerously-skip-permissions --model sonnet "<brief>"`
  in a tmux session `worker`.
- `pup-shim.sh`, installed as `pup` in the image: `session done|ask` append a
  JSON line to `~/pup-events.jsonl`, and `session test <files>` runs the
  project test command on those files.
- `proxy.Dockerfile`, `tinyproxy.conf`, `egress-allow.txt`: a tinyproxy
  container that only allows CONNECT to `api.anthropic.com`,
  `registry.npmjs.org`, `github.com` and `codeload.github.com`.
- `run-spike.sh`: `build | up | egress | attach | steer | events | fetch |
  down`. The worker sits only on a `docker network create --internal`
  network, with `--memory 4g --cpus 4`. The proxy is on that network and on
  the default bridge.
- `task-prompt.md`: the brief given to the worker. It is t-mwj2srvp's goal,
  scope and acceptance with an adapted session protocol.

The task was t-mwj2srvp, a real standard-tier task: "pup status does not list
an open question from an awaiting-review session under Needs you". It stays
in the backlog. The worker's commit `ce2f6e11` is in a bundle at
`/tmp/pup-spike/t-mwj2srvp.bundle` on the operator's machine. It was not
merged.

## Timeline of the measured run

Times are UTC. Docker Desktop 28.0.4 gives its VM 8 GiB and 8 CPUs. The host
load average was 38–51 during the run, from other pup sessions.

| Time | Event |
| --- | --- |
| 13:08:22 | `docker run` |
| 13:08:23.3 | entrypoint starts |
| 13:08:25.2 | clone done (1.9 s) |
| 13:08:27.6 | `pnpm install` done (2.4 s, cold store, 118 packages from npm) |
| 13:08:27.6 | claude starts in tmux (**5.3 s after `docker run`**) |
| 13:08:52–13:10:11 | five `pup session test` calls (dashboard test and its importers) |
| 13:10:38 | commit `ce2f6e11`, then `pup session done` (2 files, +33 −4) |
| 13:10:56 | operator steer: run the full gate |
| 13:15:37 | the worker reports the gate result |

The worker's own cost was about $0.21 and 40k tokens. It ran Sonnet at
medium effort.

## Memory

`docker stats` was sampled 44 times, about every 12 s.

| Phase | Container memory |
| --- | --- |
| claude idle or reading code | 220–300 MiB (claude itself ~340 MB RSS) |
| `pup session test` on 7 files | 530–570 MiB |
| full suite (vitest workers) | 0.9–1.13 GiB peak |
| proxy | 2 MiB |

On the host, the Docker VM process had 856 MiB resident during the run.
Docker Desktop's own processes added about 250 MiB. That overhead is paid
once, not per worker. The 4 GiB cap was never reached.

## The hard parts

### Working copy: did not bite

A blobless clone over the proxy took 1.9 s, with a 4.5 MB `.git`. The base
was GitHub's `main` (`f69ac3e9`), which this time matched the host's `main`.
pup bases a worktree on the main checkout's local `HEAD`
(`session-lifecycle.service.ts` `startSession`). A container that clones
from GitHub instead picks up unpushed local commits only if the host pushes
them first. Otherwise the two bases drift apart. The real design should clone
from a host-served bundle or pin `BASE_REF` to the host's `HEAD` sha.

The clone has no git hooks, so the repo's pre-commit hook never ran in the
container. Worktrees share `$GIT_COMMON_DIR/hooks` with the main checkout
(decision 28); a clone does not.

### Claude login: worked, but conflicts with decision 12

`CLAUDE_CODE_OAUTH_TOKEN` worked on the first try. It was set to the
operator's current OAuth access token, read from the macOS keychain, and
passed to `docker run -e` by name. Seeding `hasCompletedOnboarding` and
`hasTrustDialogAccepted` in `~/.claude.json` removed every first-run dialog.
Problems:

- **Decision 12** says pup "never handles tokens, API keys, or credential
  files". Any container design breaks that, so the ADR must amend it.
- The keychain access token expires: 5.5 h were left at launch. The refresh
  token must not go into the container. Rotating it there would log the
  host out. The right token is a long-lived one from `claude setup-token`.
  That needs one interactive operator step, and the token would be stored
  wherever pup keeps it.
- The token is readable by anyone with docker access
  (`docker inspect` shows `Config.Env`). The agent inside the container can
  also read it from its own environment. Use a secret file, not `-e`, and
  limit what that token can do.

### Dependencies: bit twice, both fixed in the image

`better-sqlite3` 13.0.1 has no install script but does have a `binding.gyp`,
so pnpm runs `node-gyp rebuild` on every install. Both failures came from
that:

1. On `node:24-bookworm-slim`, node-gyp failed without Python.
   `better-sqlite3` ships its own `prebuilds/linux-arm64.node`, but that
   binary needs glibc 2.38, and bookworm has 2.36. The fix was the trixie
   base image (glibc 2.41).
2. node-gyp also needs python3, make and g++ just to finish, and it
   downloads Node headers from nodejs.org, which the allowlist blocks. The
   fix was to install the toolchain and set `npm_config_nodedir=/usr/local`,
   because the node image already has the headers.

With those fixes, `pnpm install` takes 2.4 s on a cold store, and
`node_modules` is 188 MB per container. pnpm also printed "Ignored build
scripts: esbuild", the same as on macOS. A shared pnpm store volume or an
image layer keyed on the lockfile hash would cut the per-start download.
That is not needed at 2.4 s.

### Operator access (attach, steer, events): works through `docker exec`

- **Attach:** `docker exec -it <c> tmux attach -t worker` attached a client
  and detached cleanly. pup's `attachArgs` would need this prefix.
- **Steer:** `tmux load-buffer -` → `paste-buffer -p -d` → `send-keys Enter`
  through `docker exec -i` is the same sequence as `steerPane`. The worker
  picked it up at once.
- **Events:** pup's hooks, `events.jsonl` and `state.db` are not in the
  container. The shim's event file read back over `docker exec` was enough
  for done, ask and test. The real design needs one channel: a mounted
  per-session directory, or a socket that only this session can write.
- **Transcripts** (368 KB) stay in the container's Claude config dir and are
  lost on `docker rm`. pup's usage report and retro read them on the host,
  so they need a mount or a copy at teardown.
- **Session hooks:** pup's compiled `settings.json` (scope guard, read,
  test and bash guards) was not in the container. The worker loaded only
  the repo's `.claude/rules`. Scope was therefore enforced only at the
  gate. The worker stayed in scope on its own: 2 files, both in scope-in.

### Gate parity, macOS vs Linux: bit hard

pup fetched the commit with a git bundle: `docker exec … git bundle create -
origin/main..pup/<id>`, then `git fetch <bundle>` into a scratch clone. The
bundle was 1.3 KB and the fetch took under 1 s. This is how a commit gets out
with no push credentials. The merge gate reads branches from the main
checkout's `.git` (`merge-gate.service.ts`, no fetch). So the real design
fetches into the main repo under the session's own branch name. The spike
fetched into a scratch clone instead, so that no `pup/t-mwj2srvp` branch
would block a future real session for this task.

| Stage | Linux (container) | macOS (host, fetched commit) |
| --- | --- | --- |
| typecheck | pass, 7.4 s | pass, 5 s |
| lint | pass, 276 files, 3.1 s | pass, 276 files, 13 s |
| test | **fail: 508 / 3938 tests, 23 / 107 files**, 2 min 15 s | not run |

The macOS test stage was not run. This session's guard refuses to run the
test runner directly, and `pup merge` needs a real session. `main` passes
its gate on macOS.

The worker found that the same 40 failures in the CLI and init tests happen
with and without its change, so they come from the environment. I did not
re-run the suite to classify all 508. Running more full suites outside the
test slots is what the guard exists to stop. Two causes are clear from the
code:

- **Sandbox:** `sandbox.utils.ts` (`isSandboxSupported`, darwin only)
  refuses to run gate children elsewhere unless `PUP_SANDBOX=vm` is set
  (decision 78). The init, CLI, audit, merge-gate and adapter tests use that
  path.
- **No git identity:** the container has no global git config. Some test
  helpers commit without `-c user.*` (for example
  `merge-gate-untested.test.ts:225`).

Vitest also reported 5 unhandled errors. The one shown was an ENOENT on a
`pup-slots-*` temp dir in `test-slot.test.ts`.

So "same gate on both OSes" is not true today. Either the suite becomes
Linux-clean, or the container runs only the session's own tests and macOS
keeps the full-suite gate.

### Machine load: bit, the container ignores the test slots

The worker's tests do not take a slot from `~/.pupitre/slots` (two per
machine), so `pup session test` and gate test runs in containers are not
throttled. The run was sharing an 8-core host already at load 38–51. The
full suite took 2 min 15 s inside a `--cpus 4` cap. The Docker VM's 8 GiB is
a hard ceiling for all workers together; at ~1.1 GiB per worker under test,
that is about 6 at once. The slot lock needs to be held on the host: the
shim's `test` call has to ask the host for a slot. Docker's `--cpus` limits
one container; it does not coordinate across them.

### Egress proxy: worked, with one real hole

From inside the worker:

| Probe | Result |
| --- | --- |
| `git ls-remote` github.com | open |
| `pnpm view` registry.npmjs.org | open |
| claude → api.anthropic.com | open (7 CONNECTs in the run) |
| `git ls-remote` gitlab.com | refused by the proxy |
| nodejs.org (node-gyp headers) | refused by the proxy |
| downloads.claude.ai (claude's updater) | refused, harmless; set `DISABLE_AUTOUPDATER=1` |
| direct TCP to 1.1.1.1:443, no proxy | `ENETUNREACH` (internal network) |

The hole: the proxy sees only the CONNECT host name. Allowing `github.com`
for fetch also allows `git push https://<someone's token>@github.com/…` to
any repo, and `api.github.com` writes if that host is added later. "GitHub
read" cannot be enforced without TLS interception. The worker does not need
GitHub at all if the host provides the clone (see Working copy). Then the
allowlist shrinks to the model API and npm, and that closes the hole.

## For the ADR

Each item names what an ADR has to decide; none is decided here:

- the token: amend decision 12, use `setup-token`, deliver it as a secret
  file
- the clone source: a host bundle (it fixes the base drift, the hooks and
  the GitHub egress hole) or GitHub
- the event channel: what replaces `state.db`, the hooks and the transcripts
  inside the container
- the gate: make the suite Linux-clean, or keep macOS as the only full gate
- the test slots: lock them on the host
- the per-worker cap: 4 GiB / 4 CPUs was enough, and worked out to about 6
  workers per 8 GiB VM
