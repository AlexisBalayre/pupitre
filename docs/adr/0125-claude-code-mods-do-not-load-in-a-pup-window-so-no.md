# 0125. Claude Code mods do not register their hooks in a pup window, so conductor-worker messaging stays on tmux and `pup status` (2026-10-30)

- Status: accepted

125. **Claude Code mods do not register their hooks in a pup window, so conductor-worker messaging
    stays on tmux and `pup status` (2026-10-30).**
    A spike (task t-mvtth5rg, no production code) asked whether a Claude Code mod could let a
    worker push `turn.complete` to the conductor, so the conductor stops polling `pup status`.
    Claude Code 2.1.314. The scratch window was launched on its own `tmux -L spikeA` /
    `spikeB` socket, from the trusted worktree, with the flags a pup worker gets:
    `claude --dangerously-skip-permissions --settings /tmp/spike-settings.json --setting-sources user`
    (settings `{}`), plus the mod flag under test. The throwaway plugin lived in `/tmp/spike-mod`:
    `.claude-plugin/plugin.json` and `hooks/register.ts`, an `export const register: Register = on => {…}`
    with `session.start`, `turn.complete` and `session.receive` hooks that append a line to
    `/tmp/spike-mod.log`, and `$.session.send({ to, text })` from `turn.complete`.
    1. **Does the mod load, via `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS`? Plugin yes, hooks
       module no.** `--plugin-dir /tmp/spike-mod` and `CLAUDE_CODE_PLUGIN_DIRS=/tmp/spike-mod` both
       logged `Loaded inline plugin from path: spike-mod` in `--debug-file`. In neither run did a
       `hooks module spike-mod… loaded` line appear, though the four built-in plugins' did, and
       `/tmp/spike-mod.log` was never written, not even by `session.start`. Run from an untrusted
       directory (`/tmp`) the debug log says `hooks modules not loaded until workspace trust is
       accepted`, and the window dies at the trust prompt; from the trusted worktree that line is
       gone and the module is still not loaded, with no reason logged. The binary's strings point
       at a rollout flag (`tengu_plugin_hooks_modules`) for a person's own plugins' hooks modules,
       with built-in and organization plugins loading regardless. Past that gate lies only
       `CLAUDE_INTERNAL_FC_OVERRIDES`, an internal feature-flag override that the spike did not
       use: forcing a product's rollout gate is not a result a pup user could rely on.
    2. **Does `session.send` reach a session on another tmux `-L` socket? Not tested.** It needs
       the hook to run. The binary says `session.send` takes `{ to, text }`, `to` a name, an agent
       id, an address or `{ sessionId }`, and the cross-session messages pup sessions already
       receive travel over `/tmp/cc-socks/<pid>.sock`, not tmux, so the socket is likely no
       obstacle. That is a reading of the binary, not a measurement.
    3. **Do `turn.complete` and `session.receive` fire? Not tested**, for the same reason. Both
       names are in the binary's event list, and `turn.complete` carries the final message, the
       refusal and the usage.
    *Saving.* An estimate, not a measurement: pup keeps no log of the conductor's reads. The
    transcripts of the pupitre conductor and worker windows hold 27 to 142 `pup status` mentions
    over 78 to 597 assistant messages, about one turn in five to six. Taking the heaviest day as
    a bound, a push replaces about 100 status-read turns a day, each a full turn on the conductor's
    context floor. A push costs one turn per delivery too, about 20 to 30 workers finishing a day,
    so the net saving is about 70 turns a day, 50 to 100 with the spread. The CI wait is already
    one blocking `pup ci wait` (decision 90), so none of that comes from CI.
    **Recommendation: no-go for now.** A mod whose hooks do not register cuts nothing, and
    shipping a dependency on a flag that Anthropic rolls out per account would make the saving
    depend on a switch pup cannot set. Revisit when `claude --plugin-dir` logs a `hooks module …
    loaded` line for a plugin of the user's own in a pup window; the three checks above then take
    an hour, and the first to run is `/tmp/spike-mod.log` after one turn. Meanwhile the cheaper
    cut is on pup's side: a `pup status --wait` that blocks like `pup ci wait` until a session
    changes state.
