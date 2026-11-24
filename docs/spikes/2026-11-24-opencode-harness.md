# Spike: running workers and the conductor on opencode (2026-11-24)

## Question

Can `pup` launch a worker, or the conductor, on opencode (https://github.com/anomalyco/opencode, MIT) instead of Claude Code, chosen per task or per project, so a task can use any provider or a local model? What does the seam have to look like, what does pup lose, and in what order should it be built?

Operator decisions this spike takes as given:

- Claude stays on Claude Code with the subscription.
- Anthropic's terms do not allow routing subscription credentials through a third-party tool. So opencode runs on API keys or local models, never on a Claude subscription login.
- opencode is a second adapter behind the existing Claude-only seam (decision 207), selected per task by tier.
- The conductor must be supportable too.

## Method and limits

- **Read only, from documentation.** I read the opencode docs (the V2 docs; latest release v2.4.1 on 2026-11-23; v1.19.6 is the V1 line), `openapi.json` (178 operations), and `packages/core/src/session/sql.ts` and `packages/schema/src/token-usage.ts` on the `dev` branch. Evidence pages are cited per row. Nothing below was observed running.
- **No local-model run was possible.** `which opencode` and `which ollama` returned nothing, and I found no LM Studio. The brief says not to install global packages, so I installed nothing, created no scratch directory, and ran no model. The first build task below must start with that run (commands in "Open questions").
- Pupitre facts come from the ADRs (1, 2, 5, 10, 11, 12, 19, 35, 36, 45, 47, 74, 85, 87, 92, 112, 118, 122, 150, 152, 156, 177, 179, 191, 192, 199, 200, 207, 209) and from reading `src/claude/*`, `src/core/profile-compiler.service.ts` and the usage consumers.
- **Unverified claims** are marked *(unverified)*. The ones that decide the design:
  1. Whether `ctx.tool.hook("execute.before")` can block a call. The docs show it can inspect and replace input. Only `permission.hook("evaluate")` is documented to deny.
  2. The server's auth header. The docs name `OPENCODE_PASSWORD` and pairing codes at `/auth/connect/{code}`. I did not find how a client presents the password.
  3. The `opencode run --format json` event schema. The docs say it emits newline-delimited JSON and do not publish the schema. This design avoids depending on it by using SSE from `GET /api/event`, whose events are in the OpenAPI file.
  4. Behaviour of local models through Ollama or LM Studio with tool calls. The docs describe discovery only.
  5. V2 stability against V1. The docs describe V2. Everything here targets V2 and pins a version.

## What opencode offers (the facts the design rests on)

- **A server with an API, and a TUI that attaches to it.** `opencode serve --hostname --port` runs the server. A shared background server per user is the default, and `--standalone` gives a private one. The TUI can connect with `--server` and `--session`. So a tmux pane can show a TUI for the operator while pup drives a private server over HTTP, with no pane scraping.
- **Idle and usage are events.** `GET /api/event` is SSE. It carries `session.status`, `session.idle`, `session.execution.started|succeeded|failed|interrupted`, `session.step.*`, `session.tool.called|success|failed|progress`, `session.usage.updated|recorded` (both carry `cost` in USD and `tokens` {input, output, reasoning, cache{read, write}}), `session.compaction.started|ended|failed`, `permission.asked|replied`.
- **Steer and interrupt are calls.** `POST /api/session/{id}/prompt` queues a message and is idempotent by id; it returns on queueing. `/interrupt` stops the turn. `GET /api/session/active` lists running sessions, and absence means idle. `GET /api/session/{id}/context` returns the messages since the last compaction. `POST /api/session/{id}/compact` compacts.
- **Permissions are rules plus plugins plus policies.** Rules are `{action, resource, effect: allow|deny|ask}`, last match wins, and an unmatched check asks. A `policies` block hard-denies (`tool.use` with `shell:sudo *`) and is never prompted; it applies after agent rules and saved approvals. Global and Console policies override a project's, and the built-in policy plugin cannot be removed by a repo. A server plugin can deny in `ctx.permission.hook("evaluate")` with a `message`.
- **No OS-level sandbox.** `shell` runs with the host user's authority. Shell-command scanning is best effort, and a command it cannot analyse (such as `eval`) fails closed if any shell deny rule applies.
- **A SQLite store.** `session_v2` holds `id`, `project_id`, `parent_id`, `directory`, `title`, `cost`, `tokens_input|output|reasoning|cache_read|cache_write`, `agent`, `model` JSON, `time_busy`, `time_idle`, `idle_outcome`, `time_compacting`, `time_archived`. `opencode debug paths db` prints the path, and `OPENCODE_DB` overrides it. Context size is not a column.
- **Its own cache warming.** `warming: true|{prompt, interval, duration}` with `settings.cache.ttl`. Off by default.

## 1. Capability table

Verdicts: **same** = no adapter code beyond configuration; **adapter** = opencode does it a different way and the adapter bridges it; **gap** = opencode cannot do it, and pup either drops the feature on that harness or keeps it Claude-only.

| Capability pupitre uses (Claude Code) | opencode equivalent | Verdict | Evidence |
|---|---|---|---|
| **tmux launch** (`nice -n 10 claude --model --effort --name pup-<id> --dangerously-skip-permissions --settings <p> --setting-sources user`, decisions 1, 5, 10, 19) | `opencode serve --standalone --hostname 127.0.0.1 --port <p>` in the worktree, then `opencode --server <url> --session <id>` as the TUI in the tmux window. Config through `OPENCODE_CONFIG`-style files or `PATCH /api/config`. No "bypass" flag is needed: the base policy is allow-all and pup adds denies. | adapter | `/docs/cli/commands/`, `/docs/cli/`, `/docs/permissions/`, `/docs/api` |
| **Kickoff prompt** (poll the pane for `? for shortcuts`, 1 s steps, 45 s limit, then paste) | `POST /api/session/{id}/prompt` with a message id. It queues, so there is no readiness poll. | adapter (simpler) | `/docs/api`, `/openapi.json` |
| **Hooks and events for state and idle** (PostToolUse = activity, Notification = blocked, Stop = turn end; `events.jsonl`; stall = mtime ≥ 10 min; decisions 2, 35, 103) | SSE: `session.tool.*` = activity, `permission.asked` = blocked, `session.idle` / `session.execution.succeeded` = turn end. The adapter writes each as a line into the host `events.jsonl`, so `classifySessionActivity`, `isSessionStalled` and the turn watchdog do not change. | adapter | `/docs/api`, `/openapi.json` (events) |
| **Steering input** (`steerPane`: C-u, `paste-buffer -p`, verify the paste landed, Enter; decision 45) | `POST /prompt`. The message is one request, so decision 45's paste check has nothing to check. The queue delivers it after the current turn, as decision 4 requires. | same intent, **adapter** | `/docs/api` |
| **Interrupt** (`interruptPane` sends Escape, decision 37) | `/interrupt`. The `resume` option and steer items are unneeded. | adapter | `/docs/api` |
| **Transcripts for context, cost, compaction** (`transcript.service.latestContextTokens`; `usage-report` reads Anthropic usage fields, `compact_boundary.preTokens`) | `session_v2` cost and token columns (cumulative), `GET /context` or the latest assistant message for context size, `time_compacting` and `session.compaction.*` for compactions. | adapter (new reader, section 4) | `packages/core/src/session/sql.ts`, `/docs/compaction/` |
| **Permissions and sandbox** (compiled PreToolUse hooks exit 2; deny list; `Read(...)` credential rules; decision 191 Bash sandbox; gate `sandbox-exec`, decision 36) | Rules (`edit`, `shell`, `read`, `external_directory`), `policies` for hard denies, and a plugin using `permission.hook("evaluate")`. No OS sandbox. See section 3. | adapter for path and command rules, **gap** for OS containment | `/docs/permissions/`, `/docs/policies/`, `/docs/build/plugins/server/` |
| **Read-guard, bash-recheck** (decision 112; post-hoc dirty-path check) | `read` rules and a plugin. Post-hoc: `tool.hook("execute.after")` *(unverified that it can refuse)*, or a git-diff check at gate time. | adapter | `/docs/build/plugins/server/` |
| **Skills** (`Skill` denied unless the profile names skills; skill files in `.claude/skills`) | `SKILL.md` under `.opencode/skills`, `.claude/skills`, `.agents/skills`, plus `skills` arrays. `opencode/autoinvoke: false` hides a skill. `skill.use` policy and `skill` permission control use. | same (it reads `.claude/skills`; see risk 6) | `/docs/skills/`, `/docs/policies/` |
| **Subagents** (worker subagents pinned to Haiku, decision 152; conductor security review by a `general-purpose` subagent, decision 118; AskUserQuestion, EnterPlanMode, ExitPlanMode denied, decision 74) | `agents.<id>` with `mode: subagent`, `model`, `permissions`. Subagents run in child sessions in the background, and the parent gets a report on idle. The `subagent` permission selects which a parent may launch. `question` is a permission action, so it can be denied. | adapter (a pinned cheap model needs a local or API-key equivalent of Haiku) | `/docs/agents/`, `/docs/permissions/` |
| **Model selection** (`--model`, `--effort`, `--fallback-model`; ladder in decision 92) | `provider/model` with an optional `#variant` (e.g. `anthropic/claude-sonnet-5-5#high`) per agent, `/model` call, `agents.compaction.model`. No fallback model flag *(unverified)*. | adapter. Effort maps to variant where a provider has one; the ladder is per harness. | `/docs/models/`, `/docs/providers/`, `/docs/agents/` |
| **Utility one-shot** (`claude -p` with Haiku, `--tools ''`, 120 s, decision 11) | `opencode run --model <m> --standalone` with no tools allowed, or `ctx.generate.text`. Plain text out. | adapter | `/docs/cli/commands/` |
| **Cache hold** (decisions 156, 179: type a "held" prompt in the 50–58 min window) | opencode's own `warming`. Nothing to type; the provider TTL differs. | adapter: replace, not port | `/docs/warming/` |
| **Compaction as default reset** (decision 200; recap after compaction, decision 199) | Automatic compaction on by default (`compaction.auto`, `keep.tokens` 15000, `buffer` 15%). The recap needs a hook: `session.compaction.ended` plus `session.hook("context")`. | adapter | `/docs/compaction/`, `/docs/build/plugins/server/` |
| **Cross-session messaging** (conductor's ListAgents, SendMessage, `notify_when_idle`, decision 47) | None. | **gap** | `/docs/api` (no such operation) |
| **Subscription usage windows** (`usage.json` from the status line; launch hold at ≥85% / ≥90%, decision 156; `pup usage`, decision 122) | `GET /api/experimental/usage/limits` exists only for opencode Console sign-in. API keys have none. | **gap** (Claude-only) | `/openapi.json` |
| **Trust seeding** (`preseedTrust` in `~/.claude.json`) | Not needed. | n/a | |
| **MCP** (profile `mcp` layer) | `/api/mcp`, `mcp add`, `<server>_<tool>` permission actions, `mcp.use` policy. Config format not read in detail *(unverified)*. | adapter | `/docs/mcp-servers/` |

## 2. The adapter interface

Decision 207 sets six operations for the executor: `launch`, `steer`, `interrupt`, `kill`, `readEvents`, `fetchResult`. The harness is a different axis (which agent runs inside the executor), and the tmux executor today is the Claude harness fused with tmux. The interface below is the smallest set that both harnesses can honour. It replaces the direct imports of `session-runtime.service` by about 20 `core/*` files, `cli/index.ts` and `cli/ui/actions.service.ts` with calls through one object.

```ts
// src/claude/harness.types.ts (renamed to src/harness/ in slice 1; see risk 7)

export type HarnessId = 'claude' | 'opencode';

export interface HarnessLaunch {
  sessionId: string;          // pup session id; also the window name pup-<id>
  cwd: string;                // worktree, or the main checkout for the conductor
  role: 'worker' | 'conductor';
  model: string;              // harness-native id, from the per-harness ladder
  effort?: string;            // harness-native; ignored if the harness has none
  profileDir: string;         // compiled profile output (section 3)
  kickoff: string;            // the brief; sent as the first message
  env: Record<string, string>;
}

export interface HarnessEvent {
  at: number;                 // ms epoch
  kind: 'activity' | 'blocked' | 'turn_end' | 'compaction' | 'error';
  raw?: unknown;
}

export interface HarnessUsage {
  costUsd: number | null;     // null when the harness cannot say (local model)
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextTokens: number | null;
  compactions: number;
}

export interface Harness {
  readonly id: HarnessId;

  /** Start the agent in a tmux window. Resolves when the first message is accepted. */
  launch(opts: HarnessLaunch): Promise<void>;

  /** Deliver one whole message after the current turn. Rejects if it cannot be confirmed delivered. */
  steer(sessionId: string, message: string): Promise<void>;

  /** Stop the current turn. The session stays alive and accepts a steer. */
  interrupt(sessionId: string): Promise<void>;

  /** End the agent and free its window, server and temp files. Idempotent. */
  kill(sessionId: string): Promise<void>;

  /** Append harness events to the host events.jsonl in the shape the watchdog reads. Returns the new offset. */
  readEvents(sessionId: string, offset: number): Promise<{ events: HarnessEvent[]; offset: number }>;

  /** True while a turn is running. Used where the pane was read (deadTurnError, nudgeConductor). */
  isTurnRunning(sessionId: string): Promise<boolean>;

  /** Cost, tokens, context and compactions for one session. No transcript parsing outside this method. */
  usage(sessionId: string): Promise<HarnessUsage>;

  /** One-shot text call, no tools, with a timeout. Used by the gate-time utilities (decision 11). */
  utility(prompt: string, opts: { model: string; timeoutMs: number }): Promise<string>;
}
```

Guarantees per method:

| Method | Guarantee |
|---|---|
| `launch` | After it resolves, the agent has received the kickoff and a tmux window `pup-<id>` exists. Idempotent by `sessionId`: a second call with a live session does nothing. Applies the profile before the first message. Refuses (throws) if the profile cannot be applied, never launches unguarded. |
| `steer` | One whole message, delivered after the current turn, never split or merged. Claude: `steerPane` with decision 45's check. opencode: `POST /prompt` with a message id, so a retry cannot duplicate it. |
| `interrupt` | The turn stops and the session accepts the next steer. Does not kill. |
| `kill` | Window, private server and temp files are gone. Safe to call twice. |
| `readEvents` | Lines are in order and each is returned once per offset. opencode maps SSE to the line shapes `event-log.sh` writes, so `Stop` and `Notification idle_prompt` lines look the same. |
| `isTurnRunning` | Claude: pane signature. opencode: `GET /api/session/active`. |
| `usage` | Never throws on a missing session; returns zeros and `null`s. `costUsd` is `null` for a local model rather than 0, so a report can say "unpriced". |
| `utility` | Returns text or throws on timeout. No tools, no MCP, no session row. |

**Kept out of the interface, on purpose** (each is used by one harness only, so the third-use rule says no abstraction yet):

- Trust seeding, `--setting-sources`, the status-line `usage.json`, the pane parser (`❯` glyph, `─` row, SGR dim ghost text, `⏺ API Error:`), `readInputBox`, cache hold, `deadTurnError`, the 1 h cache TTL rules, `MODEL_PRICES`, and cross-session messaging stay in `src/claude` and are called only when the session's harness is `claude`.
- `fetchResult` and the remote executor (E2B) stay as decision 207 has them. A remote opencode worker is out of scope here.

**What stays Claude-only:** Anthropic cache economics and the cache hold, the usage-window launch hold, the transcript JSONL format, pane-based state for the conductor, and the conductor's peer messaging.

## 3. Permissions and sandbox on opencode

### How the profile compiler translates

`compileProfile` (`src/core/profile-compiler.service.ts:1573`) writes `settings.json`, eight hook scripts and `.pat` files. For opencode a second emitter writes one `opencode.jsonc` and one plugin from the same layer data (`deny`, scope-in, scope-out, `skills`, `subagents`, `mcp`). The layer YAML does not change.

| Claude output | opencode output |
|---|---|
| `scope-enforce.sh` (PreToolUse `Edit\|Write`, exit 2) | `edit` rules: `deny *`, then `allow` per scope-in glob, then `deny` per scope-out glob (last match wins). Backed by a `tool.use` policy `edit:<glob>` for scope-out paths, because a policy is never prompted and overrides saved approvals. |
| `bash-guard.sh`, `test-guard.sh` (PreToolUse `Bash`, exit 2) | `shell` rules from the same patterns, plus the plugin's `permission.hook("evaluate")` setting `effect: deny` with the guard's message so the worker sees why. |
| `read-guard.sh` (decision 112) and `Read(...)` credential denies | `read` rules and `tool.use` policies `read:*/.ssh/*`, `read:*/.aws/*`, `read:*.env`, etc. |
| `bash-recheck.sh` (snapshot dirty paths, refuse after) | `tool.hook("execute.before")` snapshots and `execute.after` compares; if `after` cannot refuse *(unverified)*, the plugin writes a `scope_violation` event line and the gate's diff check rejects. |
| deny list: UNANSWERABLE_TOOLS (AskUserQuestion, EnterPlanMode, ExitPlanMode; decision 74), WORKER_UNUSED_TOOLS | `question` deny; plan-mode agents are not selected (agent `build` only, `default_agent`). |
| `Skill` denied unless named | `skill` deny `*`, then allow the named skills. |
| `event-log.sh` (PostToolUse, Stop, Notification) | The adapter's SSE reader (section 1). No plugin needed. |
| `compact-recap.sh` (SessionStart `compact`, decision 199) | A plugin subscribed to `session.compaction.ended` that sends the recap as the next prompt, or `session.hook("context")`. |
| `statusline.sh` (writes `usage.json`) | Not emitted. Claude-only. |
| `--setting-sources user` (decision 19) | Pup writes the config to a path it controls and points opencode at it. Whether opencode merges `~/.config/opencode` and a repo's `.opencode/` cannot be turned off *(unverified)*; the launch refuses a repo that ships `.opencode/plugins` it did not compile (risk 5). |
| Outside the worktree | `external_directory` deny (it is allowed by default), plus a `tool.use` policy `external_directory:*`. |

`WORKER_UNUSED_TOOLS` names Claude tool names. Names differ in opencode's action vocabulary (`edit`, `shell`, `read`, `glob`, `grep`, `webfetch`, `websearch`), so the emitter owns one table from pup's tool classes to opencode actions. No other module sees opencode action names.

### What protection is lost without OS-level sandboxing

| Protection today | On opencode |
|---|---|
| Decision 191: Bash children confined to the worktree, git dir, store DB and handoff file, with a 4-domain network allowlist | **Lost.** `shell` runs with the user's authority. Only pattern rules remain, and they are best effort. |
| Credential directories unreadable by Bash children | **Lost for shell.** `read` rules cover the `read` tool, not `cat ~/.aws/credentials` through a shell. Mitigation: `shell` deny patterns for `*~/.ssh*`, `*~/.aws*`, `*.env*`, and the dynamic-command fail-closed behaviour. Neither is a boundary. |
| Main `.git` config, hooks and refs denied to the worker (decisions 117, 191) | **Lost for shell.** `edit` rules cover the edit tool. A shell redirect into `.git/hooks` is only blocked if a pattern catches it. The post-hoc git check at gate time catches a changed hook only after it ran. |
| Network allowlist | **Lost.** `webfetch` and `websearch` can be denied, but a shell `curl` cannot be bounded. |
| Dynamic commands (`eval`, `$(...)`) | opencode fails them closed when any shell deny applies. That is stricter than bash-guard and may refuse legitimate builds; expect `pnpm` scripts to need explicit allows. |
| Gate `sandbox-exec` (decision 36) | **Unchanged.** It wraps the gate's test run on the host, not the session. It stays the main containment for anything a worker wrote. |
| Merge-gate scope re-check at merge | **Unchanged.** It reads the branch diff, so a shell write outside scope is still refused at merge. |

So the honest position: on opencode a worker's file writes through the edit tool are as enforced as on Claude, and shell is advisory. The containment that remains is the gate and the merge re-check, which act after the fact. That argues for two rules in the selection config: an opencode worker is refused on a Critical-tier task (decision 92's `CRITICAL_AREAS`), and decision 191's sandbox option must be on a different mechanism before opencode is used where a worker holds secrets. A VM or container (decision 207's executor) would restore it; that is a separate slice, not assumed here.

## 4. Gate, review and retro without a Claude transcript

What reads a transcript today (checked by grep): `usage-report.service.ts` (`pup usage`, and retro through `scanUsage`), `dashboard.service.ts:961` (`latestContextTokens`), `retro-signals.service.ts` and retro replay (decision 192). `review.service` and the merge gate read no transcript and no cost. `gate` reads the diff, tests and store. So the gate and review need no change; the work is in the three reporting readers.

**An opencode reader.** `src/harness/opencode/usage.reader.ts` opens the opencode SQLite file read-only (path from `opencode debug paths db`, or `OPENCODE_DB`; resolved once at launch and stored on the session row so a later config change cannot move it) and runs, for a pup session's opencode session id and its child sessions (`parent_id`):

```sql
SELECT id, cost, tokens_input, tokens_output, tokens_reasoning,
       tokens_cache_read, tokens_cache_write, time_compacting, model
FROM session_v2 WHERE id = ? OR parent_id = ?;
```

- **Cost:** sum of `cost`. opencode computes it from its model catalogue. For a local model it is 0 or absent, so the reader returns `null` and reports show "unpriced", not "$0".
- **Tokens:** `tokens_input|output|cache_read|cache_write`. Reasoning tokens are reported but not added to output, so retro does not double count.
- **Context size:** not a column. Use `GET /api/session/{id}/context` while the server is up, and for a finished session the tokens of the latest assistant message in `session_message`. The query shape depends on the message JSON, which is not documented *(unverified)*; the reader should read `session.usage.updated` into a host file as it goes, so the finished-session case does not depend on the table layout.
- **Compactions:** count of `session.compaction.ended` events the adapter saw, falling back to a non-null `time_compacting`.
- **Schema drift:** `session_v2` is an internal table with migrations. The reader checks the column set at open and returns "unreadable" with the version, rather than a wrong number. The event copy is the fallback.

`usage-report` keeps its Claude path, and gains a second source behind `Harness.usage`. Pricing (`MODEL_PRICES`), the cache 1 h TTL rules and `entrypoint==='sdk-cli'` stay Claude-only. A retro that mixes harnesses prints one row per harness and does not sum cache hit rates across them, since Anthropic cache semantics do not apply.

`usage-limits.service.ts` (the subscription launch hold) is Claude-only. An opencode launch skips it and the status line shows no window (section 6). A cost ceiling for API-key harnesses is a separate need: decision 177's ticket token budget can read `HarnessUsage` the same way, which is the one reason to define the reader before the launch hold.

## 5. The conductor on opencode

What the conductor is (decision 47): `claude` in tmux named `pup-conductor-<project id>`, cwd the main checkout, no row, worktree or branch. Its profile has an always-exit-2 edit block, bash-guard and a SessionStart compact recap. It has no event hook, no scope files and no events file. Its state comes from the pane (`conductorBlock`, `nudgeConductor`) and a blocked-since file.

**What breaks on opencode:**

1. **Peer messaging.** The conductor steers workers with ListAgents, SendMessage and `notify_when_idle`. These are Claude Code features, and opencode has no equivalent operation. The fallback is `pup steer <id>` and `pup status`, which exist already. The conductor prompt must be a second variant that never names the Claude tools. Workers must also not depend on being messaged by name.
2. **State from the pane.** `conductorBlock` and `nudgeConductor` parse Claude's pane. On opencode the TUI is a different screen, so they cannot be reused. The replacement is the adapter's `isTurnRunning` and `permission.asked`, which is better than pane reading.
3. **No event hook (decision 47), no clock (decision 209).** On opencode there is an event stream, so a conductor events file is possible without a hook. That is exactly the "clock" decision 209 says reopening needs. It does not change decision 209 for Claude. It does mean decision 209's rejected hold is moot on opencode, since `warming` is opencode's own mechanism.
4. **Edit block and bash-guard.** The edit block is `edit` deny `*`. Bash-guard is the same `shell` rule set as workers. Both are expressible. The conductor needs `shell` for `pup ...`, so the shell scanner's best-effort nature matters more here than for a worker: the conductor holds the operator's authority to launch and merge.
5. **Recap after compaction (decision 199).** Needs the `session.compaction.ended` plugin.
6. **Security review by a `general-purpose` subagent (decision 118).** opencode ships `general` and `explore` agents, but their prompts differ. The review must be defined as a pup-owned agent with a fixed prompt and read-only permissions, not borrowed by name.
7. **The conductor is the operator's console.** On Claude it is not niced and the operator types into it. Over opencode's server, the operator's TUI and pup's API calls share one session. A pup `steer` mid-turn queues, which is safe, but pup's idle detection must not treat the operator's own prompts as nudges.

**What must be true first:**

- The worker adapter works on opencode (slices 1–5), so the conductor is not the first consumer.
- A decision that the conductor profile may have an event feed on opencode, recorded as an amendment to 47 and 209.
- `tool.hook` blocking, the auth mechanism and compaction-recap behaviour verified by the first run.
- A conductor prompt variant without peer messaging, tested against `pup steer`.
- A choice of model: the conductor is Opus high today. An opencode conductor on a small local model would plan and merge badly; the selection config should refuse a conductor on a model below a floor the operator sets (section 6).

## 6. Selection, refusals and the status line

### Config

There is no harness field in project config or on the task today. Add one, defaulting to `claude` so nothing changes for existing projects.

```yaml
# project config
harness:
  default: claude
  byTier:
    standard: claude        # worker tier names from decision 92
    critical: claude
  conductor: claude
  opencode:
    ladder:                 # replaces decision 92's ladder for this harness
      standard: ["anthropic/claude-sonnet-5-5#medium", "anthropic/claude-sonnet-5-5#high"]
      utility: "ollama/qwen3:8b"
    server: standalone      # standalone | shared
```

Per task: `pup plan add|edit --harness opencode`, beside the existing `--tier` flag (`src/cli/index.ts:1291`), stored on the task and copied to the session at launch, as the tier is. Precedence: task flag, then `byTier`, then `default`. The tier still decides the ladder; the harness decides which ladder.

### Refusals

`pup new`, `pup plan add --harness` and the launcher refuse, with a message that names the fix, when:

- the harness is `opencode` and the model resolves to a Claude subscription login. Detection: the provider is `anthropic` and no `ANTHROPIC_API_KEY` is configured, or opencode's account list holds a Claude OAuth login. This enforces the operator decision and decision 12 (no programmatic auth for Claude).
- the harness is `opencode` and the tier is Critical (section 3).
- `opencode` is not installed or is below the pinned version.
- the profile emitter cannot apply the compiled rules (for example the plugin failed to load). A guard that did not load means no launch.
- the repo ships `.opencode/` plugins or config that pup did not compile (risk 5).
- the conductor is on `opencode` with a model below the configured floor.
- an opencode launch requests a Claude-only feature: cache hold, usage-window hold, `--fallback-model`. The feature is skipped with a printed notice for a worker, and refused for the conductor, since the conductor's behaviour depends on peer messaging.

### Status line

The Claude status line writes `usage.json` (`five_hour`, `seven_day`). An opencode session shows, in the dashboard row and `pup status`:

- `oc` harness tag and the model, e.g. `oc ollama/qwen3:8b`;
- tokens and cost from `HarnessUsage`, `unpriced` for a local model;
- context tokens when known;
- no subscription window and no cache-hold column (`—`, not 0%).

The launch hold on subscription windows (decision 156) does not apply to an opencode launch and the launcher prints that it was skipped.

## 7. Risks, build order, amended decisions, slices

### Risks

1. **Guards that never load.** The plugin or policy fails silently and the worker runs allow-all (opencode's base policy is allow-all). Mitigation: the adapter verifies via `GET /api/config` and a probe denied-edit before the kickoff, and `launch` refuses otherwise.
2. **Shell is advisory** (section 3). Mitigation: Critical refused, gate and merge re-check unchanged, the VM executor as later work.
3. **`session_v2` is internal.** Mitigation: column check at open, SSE copy as the primary source.
4. **V2 churn.** The docs are V2 and V1 is still released. Mitigation: pin a version, check it at launch, record the version in the session row.
5. **Config merging.** A repo's `.opencode/` or a user's `~/.config/opencode` may add plugins or loosen rules. Policies from global and Console override the project, which is helpful, but a user-level plugin can still run. Mitigation: refuse unknown plugins in the worktree; document that the operator's global config is trusted.
6. **Double skill loading.** opencode reads `.claude/skills`, so a Claude skill may load in both harnesses with different semantics. Never touch `.claude/`; the emitter lists skills explicitly.
7. **`src/claude` becomes the wrong name.** Decision 207 says `src/claude` is the only module touching Claude Code. A second harness inside it is wrong. Rename to `src/harness/` with `claude/` and `opencode/` below it, as slice 1, and amend 207's sentence.
8. **Local-model quality.** A small model may not follow the brief, scope rules or `pup session done`. The worker gate and review then reject it, which costs time rather than safety. The selection config's floor and the review loop are the mitigation, not a guarantee.
9. **Shared background server.** The default shared server would mix sessions and credentials across pup windows. Use `--standalone` per window and refuse `shared` until its isolation is shown.
10. **Cost surprise.** API keys have no subscription ceiling. Decision 177's token budget must apply to opencode sessions before API-key use is allowed.

### Build order

1. Seam refactor with Claude only, behaviour unchanged (the interface of section 2).
2. The first run of opencode with a local model, to settle the *(unverified)* items.
3. opencode worker launch, steer, interrupt, kill, and the event bridge.
4. Profile emitter and guard verification.
5. Usage reader, utility call, reports.
6. Selection config and refusals.
7. Conductor.

The conductor is last because it is the most security-sensitive and depends on every other piece.

### Decisions this spike would amend (by number)

| Decision | Change |
|---|---|
| 1 | Sessions are interactive `claude` in tmux, or an opencode TUI attached to a private server in tmux. |
| 2 | State comes from hooks and transcript, or, on opencode, SSE events written to the same events file. Pane contents remain forbidden as a state source for workers. |
| 5 | "Bypass permissions; compiled hooks are the enforcement" becomes, on opencode, "allow-all base policy; compiled rules, policies and plugin are the enforcement". |
| 10 | The compiled profile is delivered with `--settings`, or as an opencode config and plugin. |
| 11 | Utility calls go through `Harness.utility`. |
| 12 | Opencode uses API keys or local models. This is a new credential class that the amendment must scope (where keys live, who can read them). |
| 19 | `--setting-sources user` has an opencode analogue only if config merging can be restricted. |
| 47 | The conductor may run on opencode with an event feed. |
| 92 | The model ladder is per harness. |
| 179, 209 | Cache hold is per harness. On opencode, `warming` replaces it. |
| 207 | The seam is the harness adapter; `src/claude` is renamed. A remote executor and a harness are separate axes. |
| 74, 191, 199, 122, 150 | Smaller wording changes: which tools are denied, what the sandbox covers per harness, the recap after compaction, `pup usage` and `pup retro` reading `HarnessUsage`. |

### Slice plan (ready for `pup plan add`)

**Slice 1: Extract the harness seam, Claude only, no behaviour change.**
Scope-in: `src/claude/**`, `src/harness/**`, `src/core/*.service.ts` files that import `session-runtime.service` (about 20), `src/cli/index.ts`, `src/cli/ui/actions.service.ts`, `test/unit/claude/**`, `test/unit/harness/**`.
Acceptance: the `Harness` interface of section 2 exists; a `claude` implementation wraps the current functions; no `core/*` file imports `session-runtime.service` directly; `src/claude` is renamed or re-homed per risk 7; the full suite passes with no changed assertions other than import paths; no shims left.

**Slice 2: First run of opencode with a local model, and a verification note.**
Scope-in: `docs/spikes/2026-11-24-opencode-harness.md` (append a "First run" section).
Acceptance: opencode and a local model are installed by the operator, not by the session; the exact commands and output are recorded; items 1 to 4 in "Unverified claims" are each marked confirmed or refuted; the scratch directory is deleted. This slice may be run by the operator.

**Slice 3: opencode worker launch, steer, interrupt, kill and event bridge.**
Scope-in: `src/harness/opencode/**`, `src/core/session-activity.utils.ts` (only if the line shape needs a case), `test/unit/harness/opencode/**`.
Acceptance: a worker launches on a private server in tmux with the TUI attached; `steer` is idempotent by message id; `interrupt` stops a turn and a later steer works; SSE events appear in the host `events.jsonl` as lines `classifySessionActivity` and `isSessionStalled` read unchanged; `kill` twice is safe; tests use a fake server, not the real binary.

**Slice 4: Profile emitter for opencode and guard verification.**
Scope-in: `src/core/profile-compiler.service.ts`, `src/core/profile-compiler-opencode.service.ts` (new), `src/harness/opencode/**`, `test/unit/core/profile-compiler*.test.ts`.
Acceptance: from one layer set, the emitter produces `opencode.jsonc` and a plugin with the rules in section 3; scope-in, scope-out, credential reads, `external_directory` and the `question` deny are asserted; launch probes that a scope-out edit is denied and refuses otherwise; the Claude output is byte-identical to before (profile-hash unchanged for the same layers).

**Slice 5: `HarnessUsage` reader, utility call, report integration.**
Scope-in: `src/harness/opencode/usage.reader.ts`, `src/core/usage-report.service.ts`, `src/core/dashboard.service.ts`, `src/core/decision-record.service.ts`, `test/unit/harness/opencode/**`, `test/unit/core/usage-report*.test.ts`.
Acceptance: the reader returns cost, tokens, context and compactions from a fixture SQLite DB; a changed column set returns "unreadable" with the version; local models report `unpriced`; `pup usage` and retro print one row per harness without summing cache hit rates; `decision-record` calls `Harness.utility`.

**Slice 6: Selection config, `--harness` flag, refusals, status line.**
Scope-in: `src/core/project-config*.ts`, `src/core/task*.ts`, `src/core/session.types.ts`, `src/cli/index.ts`, `src/cli/ui/**`, `test/unit/core/**`, `test/unit/cli/**`.
Acceptance: `harness.default`, `byTier` and `--harness` resolve in the order of section 6; every refusal in section 6 has a test and a message that names the fix; existing projects with no `harness` key behave exactly as before; the dashboard row shows `oc`, model, tokens and `unpriced`.

**Slice 7: Conductor on opencode.**
Scope-in: `src/harness/opencode/conductor*.ts`, `src/core/profile-compiler.service.ts` (`compileConductorProfile` at :1974), `src/core/conductor*.ts`, `test/unit/**`.
Acceptance: a conductor prompt variant without peer messaging; edit deny and shell rules emitted; recap after `session.compaction.ended`; `nudgeConductor` and `conductorBlock` have an opencode path using `isTurnRunning` and `permission.asked`; a pup-owned security-review agent replaces the `general-purpose` reference; launch refuses a model below the floor. Blocked on the amendment to 47 and 209 being accepted.

**Slice 8: Decision records.**
Scope-in: `docs/adr/**`.
Acceptance: one decision for the harness adapter amending 1, 2, 5, 10, 11, 12, 19, 92 and 207; one amending 47, 179 and 209; the index is regenerated; written after slice 2 so it records what was verified, and before slice 3 merges.

## 8. Open questions for the operator

1. **Who installs and runs opencode for slice 2?** The session could not, and may not install global packages. Suggested commands: `npm view opencode-ai version` to confirm the package name, a local install in a scratch directory, `ollama serve`, `ollama pull qwen3:8b`, then `opencode run --standalone --model ollama/qwen3:8b "list the files here"` in a scratch directory outside the repo, and `opencode debug paths db`. Is a local install in a throwaway directory acceptable?
2. **Is shell being advisory acceptable on opencode?** The recommendation is: yes for Standard-tier tasks without secrets, and Critical is refused. If not, a VM or container executor (decision 207) must come before slice 3.
3. **Which API-key providers are allowed?** Anthropic API keys are not a subscription login, so they satisfy the rule, but decision 12 says no programmatic auth. Where may the key live, and is a key in the process env of a worker acceptable?
4. **What is the model floor for a worker and for the conductor?** For the conductor, the recommendation is to allow only API-hosted models of at least Sonnet class until a local model is shown to merge safely.
5. **Do you accept Critical-tier refusal on opencode?** It is the cheapest safety rule and is easy to loosen later.
6. **Should the conductor wait?** The recommendation is to build slices 1 to 6 and run workers for a few weeks first. The conductor holds merge authority, and its guard is the weakest part of the opencode permission model.
7. **Rename `src/claude`?** Decision 207 says `src/claude` is the only module that touches Claude Code. The recommendation is to rename to `src/harness/` and amend that sentence. The alternative is `src/claude` and `src/opencode` side by side, which leaves the interface with no home.
8. **Which cost ceiling for API-key sessions?** Decision 177's budget exists for tickets. Is it enough, or does a per-day cap per harness belong in the same slice as the reader?

## Decided by the operator (2026-11-24)

1. **Sandbox gap.** A worker on opencode runs only inside a container or VM. The container executor of decision 207 comes before the permission and sandbox slice (slice 3); no opencode worker runs on the host shell.
2. **Conductor.** Workers first. The conductor on opencode waits until workers have run for a few weeks, and then allows only API-hosted models at Sonnet class or better.
3. **Keys.** OpenAI and Google API keys, set by the operator in their own shell environment. The worker inherits a key only for opencode sessions, and no session or agent reads, stores or prints one. An Anthropic API key stays out.
4. **Seam name.** Rename `src/claude` to `src/harness/` with the Claude Code and opencode adapters beneath it, and amend the sentence in decision 207.
5. **Still open.** The local-model install and probe (question 1), the model floor for a worker (question 4) and the cost ceiling for API-key sessions (question 8) are not decided.
