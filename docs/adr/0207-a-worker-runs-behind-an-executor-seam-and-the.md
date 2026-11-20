# 0207. A worker runs behind an executor seam, and the first remote executor is E2B (2026-11-20)

- Status: accepted
- Amends: [0001](0001-sessions-are-interactive-claude-in-tmux-panes.md)

207. **A worker runs behind an executor seam, and the first remote executor is E2B (2026-11-20).**
    The 2026-11-16 container spike (`docs/spikes/2026-11-16-container-worker.md`) showed that a
    worker runs well away from the operator's machine. It found five problems: the suite is not
    Linux-clean, a token conflicts with decision 12, a host allowlist cannot tell a read from a
    write, the container ignores the test slots, and `pup session …` and the hooks cannot reach
    the container. This decision says where a remote worker fits and what stays on the host.
    Decision 191's in-process sandbox stays the containment for a local worker.
    *The seam.* `src/claude` gets one executor interface. The tmux executor implements it by
    calling the existing `session-runtime.service.ts` functions, and the E2B executor implements it
    too. It has six operations:
    `launch(brief, baseSha)` starts a worker on a clone at `baseSha` with the compiled brief.
    `steer(message)` delivers one whole message. As decision 4 says, a steer waits for the turn
    to end. `interrupt()` stops the current turn, which is decision 37's escape hatch.
    `kill()` ends the worker and frees what it holds. `readEvents(offset)` returns the event lines
    written after `offset`. `fetchResult()` returns the worker's commits as a git bundle whose one
    prerequisite is `baseSha`. A patch is rejected because it loses the commits and their messages,
    and the spike already moved a commit out as a bundle in under 1 s.
    Locally, `steer` is `steerPane` with decision 45's check that the paste landed whole, and
    `interrupt` is `interruptPane`. Remotely, there is no pane, so the message is a file argument
    to the next turn and arrives whole.
    *What stays on the operator's machine.* These stay local: the store and `state.db`, the merge
    lock, the gate, the conductor, merge and land, the test slots the gate takes, and the
    transcripts pup's usage report and retro read. A remote worker only writes commits and event
    lines. The host verifies both before using them.
    `fetchResult`'s bundle is checked against `baseSha` and fetched into the main checkout under
    the session's own branch `pup/<id>`, where the merge gate already reads branches. From that
    point the gate runs exactly as it does for a local session.
    *Clone source and egress.* The sandbox clones from a bundle the host builds. The bundle is
    pinned to the host's HEAD sha at launch, which becomes `baseSha`. The sandbox does not clone
    from GitHub. The clone checks that its HEAD equals `baseSha` before the brief is sent. This
    fixes the spike's base drift and removes GitHub from what the sandbox can reach, so it needs
    no push credential.
    That offline install runs `better-sqlite3`'s `node-gyp rebuild`, and the egress rule blocks
    nodejs.org (`docs/spikes/2026-11-16-container-worker.md`, L137-150). So the template must
    carry `python3`, `make`, `g++`, the Node headers and `npm_config_nodedir` pointing at them.
    The sandbox may reach the model API (`api.anthropic.com`) and nothing else. Dependencies
    come from the template's pre-filled pnpm store with `pnpm install --offline`. The npm
    registry is closed because the spike showed it accepts authenticated writes and so is an
    exfiltration channel. A lockfile the template's store cannot satisfy fails the launch. The
    fix is to rebuild the template, never to open the registry. If the executor cannot set the
    sandbox's network rules to that one host, it refuses to launch.
    The model API is still a channel to whatever account owns the token. That is decision 12's
    question, below.
    *The event channel.* Two kinds of line leave the sandbox, and only one of them is a file copy.
    Hook lines: inside the sandbox, the compiled hooks append to a sandbox-local `events.jsonl`,
    using the same `jq` line `profile-compiler.service.ts` writes today. The host polls
    `readEvents(offset)`. It replaces each line's `pup_session_id` with the session id the host
    launched, and it appends the line to the session's host `events.jsonl` (`paths.eventsFile`).
    That file reaches no further than it does for a local session. No code path folds its lines
    into `state.db` (decision 63). The dashboard and the turn watchdog read its mtime.
    `classifySessionActivity` reads its `Stop` and `Notification` `idle_prompt` lines. Decision
    63's `scope_violation` lines stay in it. The host copies every hook line and parses only
    those types.
    Session signals: locally, `pup session done`, `ask` and `handoff-done` write the store and
    no file. They call `markSessionDone` (a `session_done` event and the move to
    awaiting-review), `markSessionQuestion` (a `question` event) and `markHandoffReady`. In the
    sandbox, the `pup` shim appends each call as one `pup_signal` line to the sandbox's
    `events.jsonl`. The host executor does not copy a `pup_signal` line. It replays the line
    through the same function the local command calls, for the session id it launched, once
    per line by the `readEvents` offset. A remote done, question or handoff then reaches
    `state.db` the way a local one does. A signal that function refuses is told to the worker
    in the next turn's message, because the shim cannot wait for the host. `pup session recap`
    reads the store, so the host writes its answer into the sandbox before each turn, and the
    shim prints that file.
    The replay offset lives on the host, per sandbox, beside the session's host `events.jsonl`.
    When a session continues in a fresh sandbox after the 1-hour limit, the new sandbox has a new
    `events.jsonl`, so the offset resets to 0 with it. A replay can still repeat a line, for
    example when the host stops between replaying and saving the offset. So replayed `done`,
    `ask` and `handoff-done` must be idempotent. `markHandoffReady`
    (`src/core/session-handoff.service.ts`) reads the host's handoff file and throws
    `HandoffMissingError` without it, so the executor must fetch the handoff document to the
    host before it replays a `handoff-done` line.
    The end of a turn comes from the executor, not from a pane. That is the exit of
    `claude -p` together with its result line. After each turn, the transcript is copied back to
    the session's host directory.
    *E2B Hobby limits shape the design.* The plan allows 10 concurrent sandboxes. The launcher
    counts remote workers against that number, alongside decision 197's backlog and load rule.
    A sandbox lives at most 1 hour, so no state may live only in the sandbox for longer than a
    turn:
    - after each turn, the host takes `fetchResult` and the transcript;
    - a worker waiting on a steer or an operator answer is paused, and resumed when one arrives;
    - a session that outlives its sandbox continues in a fresh sandbox, cloned from the host
      bundle plus its last result bundle, with the transcript restored.
    The pause rests on two assumptions that are unverified. One is that paused time does not
    count toward the 1-hour limit. The other is that a paused sandbox does not hold one of the 10
    concurrent slots. If either is false, the launcher's count and the pause rule change. The
    first trial measures both.
    The worker runs from the `claude` template as headless `claude -p`, one process per turn. The
    session continues with `--resume <session id>`. That headless use is what amends decision 1
    for remote workers. Local sessions stay interactive `claude` in tmux, and
    `pup attach` refuses a remote session.
    *The Linux gap, and why the gate stays on the host.* In the spike, 508 of 3938 tests (23 of
    107 files) failed on Linux. Two causes are known:
    - decision 78's `isSandboxSupported` is darwin-only;
    - some test helpers commit with no git identity.
    So the full-suite gate stays on the operator's macOS host. In the sandbox,
    `pup session test` runs only the named files, and the template sets a git identity. A failure
    there can come from the environment, so the worker reports it and does not treat it as proof.
    Making the suite Linux-clean is separate work, not a precondition, because nothing merges
    without passing the host gate. The sandbox's tests run on E2B's CPUs, so they take no host
    test slot. The 10-sandbox cap is what bounds them.
    *What this does not change.* `src/claude` stays the only module that touches Claude Code,
    and both executors live in it. Launch stays operator-only: only the operator's `pup` (the
    conductor or `pup new` on the host) creates a sandbox, and a worker cannot start another.
    *Not decided here.* The E2B executor needs the `e2b` SDK, which is a new dependency, and two
    credentials, an E2B API key and a Claude token in the sandbox. Both conflict with decision 12.
    The change that implements the executor amends decision 12 and gets the dependency approved.
    Until then, the remote executor is off.
