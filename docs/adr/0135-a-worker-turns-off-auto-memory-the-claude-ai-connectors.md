# 0135. A worker turns off auto-memory, the claude.ai connectors and Claude in Chrome, and denies the deferred tools it never calls (2026-11-07)

- Status: accepted
- Amends: [0107](0107-every-compiled-settings-file-turns-off-the-artifact.md)

135. **A worker turns off auto-memory, the claude.ai connectors and Claude in Chrome, and
    denies the deferred tools it never calls (2026-11-07).** After decision 107 a worker's
    first request still carried what is the operator's, not the task's: their auto-memory
    `MEMORY.md` (~2.2k tokens; a worktree resolves to the main checkout's memory directory),
    the Claude in Chrome server's instructions and tools and the claude.ai connectors (~2.4k),
    and the names of a dozen deferred tools no worker calls (~1.3k).
    *Auto-memory.* A worker's compiled `settings.json` sets `autoMemoryEnabled: false`, so it
    neither loads the operator's memory nor writes to it.
    *Connectors and Chrome.* `WORKER_SLIM_CONTEXT_ENV` adds `ENABLE_CLAUDEAI_MCP_SERVERS=false`
    and `CLAUDE_CODE_ENABLE_CFC=false` to a worker's `env`, after `SLIM_CONTEXT_ENV`. Both go
    in the settings file for decision 107's reason. The CLI flag `--no-chrome` would do the
    same job, but the flag belongs to the launch arguments. With no flag, the 2.1.319 binary
    reads `CLAUDE_CODE_ENABLE_CFC=false` at that same startup check and keeps Chrome off.
    `--strict-mcp-config` naming only codegraph was rejected: it would also drop the
    operator's own user-level servers, which sessions inherit (decision 9). The
    `disableClaudeAiConnectors` setting is the same switch as the env var; the env var keeps
    every switch in one block.
    *Deferred-tool denies.* A worker's `WORKER_UNUSED_TOOLS` adds `CronCreate`, `CronDelete`,
    `CronList`, `DesignSync`, `EndConversation`, `EnterWorktree`, `ExitWorktree`,
    `NotebookEdit`, `PushNotification`, `RemoteTrigger`, `WebFetch` and `WebSearch`, each a
    bare name (decision 107), after decision 107's three. Plan mode is already denied
    (decision 74). A worker keeps `SendMessage` and `ListAgents`, which it uses to reach its
    peers (decision 99), and `Agent`, which it uses to delegate reading. `Monitor` and
    `TaskStop` stay too: a worker waits on and stops its own background jobs.
    *The conductor is unchanged.* It is the operator's window. Its env is still
    `SLIM_CONTEXT_ENV` alone, it has no `autoMemoryEnabled` key, and it denies decision 74's
    three only.
    *Measured.* Two throwaway interactive windows ran in this worktree on 2.1.319, with a
    worker's flags and the prompt `Reply with the single word ok.`. Each read with decision
    107's `jq` line. The only difference between them was the settings file: `before` was
    this session's compiled one, `after` added this decision's keys. Both left out the hooks
    and the code-graph server, neither of which moves the difference. `before` read 14,313
    tokens and `after` 9,714, which is 4,599 fewer (32%). The Chrome instructions, the
    memory file and the denied names were in `before`'s first request and missing from
    `after`'s. `SendMessage` and the agent listing were in both. In neither run had the
    claude.ai connectors connected by the first request. In a real worker they had: this
    session's own first request, 20,292 tokens with the kickoff and the code graph, lists
    them. So their share of the saving is not in the 4,599.
    *Tests.* In `profile-compiler.test.ts`, a worker's settings carry `autoMemoryEnabled:
    false` and the five env variables. A worker's deny list holds the fifteen unused tools in
    order, and never `SendMessage`, `ListAgents` or `Agent`. The conductor's env is the
    three variables, and its settings have only `env`, `hooks` and `permissions`.
