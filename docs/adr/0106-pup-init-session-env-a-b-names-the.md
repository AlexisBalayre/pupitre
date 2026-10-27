# 0106. `pup init --session-env A,B` names the variables every session and conductor window gets from the launching shell, through the window's own `-e`, from a closed list (2026-10-26).

- Status: accepted
- Amends: [0047](0047-a-conductor-session-is-the-operator-s-delegate.md)

106. **`pup init --session-env A,B` names the variables every session and conductor window gets
    from the launching shell, through the window's own `-e`, from a closed list (2026-10-26).**
    Amends decision 47. `tmuxEnv` strips every `CLAUDE*` and `ANTHROPIC_*` variable from the
    environment it hands tmux, so a run could not pin `CLAUDE_CONFIG_DIR`,
    `CLAUDE_CODE_EFFORT_LEVEL`, `CLAUDE_CODE_SUBAGENT_MODEL(_FORCE)` or
    `CLAUDE_CODE_ENABLE_TELEMETRY` for its workers, which the six-ways experiment's W4b needs.
    `pup init --session-env` takes a comma-separated list, parsed like `--gate-env`, and records
    it in `session-env.json` beside the project's store (`~/.pupitre/<id>/`). Every window pup
    opens, whether a launch, a respawn, a fix round or the conductor, reads the list and adds
    each name the launching shell has a value for to the window's own `tmux -e`, with that
    value, read at launch. A name with no value is not set at all, empty included, so the
    window inherits what its server's global environment holds for it. On the default server,
    where every session's window is, any session can set that with `tmux set-environment -g`,
    as it could already for every variable a window is not handed. The strip list is unchanged:
    the named variables are still kept out of the tmux client's environment, so a client that
    starts a server never makes them its global environment, readable with
    `show-environment -g`. The conductor gets them too, so the sessions it launches from its
    Bash are handed the same values. `autoMemoryDirectory` is a settings key, not a variable: a
    run sets it in the `settings.json` of the config dir it names.
    *A closed list, not a denylist.* `--session-env` takes those five names and no other
    (`SESSION_ENV_ALLOWED`). The namespace decision 47 strips by pattern is open-ended. Every
    Claude Code shell, the conductor's included, carries `CLAUDECODE` (the nested-session
    marker), `CLAUDE_CODE_SESSION_ID` and the peer channel's `CLAUDE_CODE_MESSAGING_*`, and
    Claude Code keeps adding credentials (`CLAUDE_CODE_OAUTH_TOKEN`,
    `ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_CUSTOM_HEADERS`). Outside it are the loaders
    (`NODE_OPTIONS`, `DYLD_*`, `LD_*`, `BASH_ENV`, `ENV`), git's redirects (`GIT_DIR`,
    `GIT_INDEX_FILE`, `GIT_CONFIG_*`) and the shell's own (`HOME`, `PATH`, `SHELL`). No
    denylist covers all of that, which is what gate-env's `SETTABLE_VARS` says of gate
    children. A name off the list costs one line of pup's source. `pup init` refuses the
    whole list before anything measures, naming the first refused variable and the five it
    takes, and stores nothing.
    *The file is a session's to write.* No OS sandbox keeps a session out of `~/.pupitre`
    (decision 44), so a worker can choose the names the next launch, respawn, fix round or
    conductor start reads. The list bounds that choice: the read checks every name against it
    again and drops one off it. The file is read like a pointer a session wrote. It is opened
    with `O_NOFOLLOW | O_NONBLOCK`, and only a regular file of at most 4 KiB is read. A file
    that does not parse as a list reads as no names. `pup init` writes a staged copy and
    renames it over, so a launch never reads half a list. A value is read with `Object.hasOwn`,
    so no name reads an inherited property.
    *A value ending in `;`.* tmux reads an argument ending in `;` as the end of its command, so
    such a value cut the launch's argv. A `-e` pair ending in `;` is passed ending in `\;`
    instead, which tmux turns back into `;`, dropping that one backslash (verified on tmux 3.7b).
    *`CLAUDE_CONFIG_DIR` moves what decision 9 inherits.* A window on a named config dir loads
    its settings, hooks and MCP servers, and keeps its `.claude.json` and transcripts, there
    rather than in `~/.claude`. So `claudeUserDir(repoPath)` answers which dir a window of the
    project runs on: the shell's `CLAUDE_CONFIG_DIR` when the list names it, `~/.claude`
    otherwise. It must be absolute, since tmux expands no `~` and a relative one would resolve
    against each window's own cwd. It must also be a directory the operator owns, through any
    link, that neither its group nor others can write. Every window, the conductor's included,
    loads the hooks a `settings.json` there names, so a dir another local user made first,
    under `/tmp` say, would run that user's commands in each. Nor may anyone else be able to
    swap it once checked: `/tmp/w4b/claude` in a `/tmp/w4b` another user made is the
    operator's own, but that user can rename it away and put theirs in its place while the
    window starts. So the path is resolved a component at a time, as the kernel does, and
    every dir and link on the way, each hop of a link's target included, must be owned by the
    operator or root, with no dir on it writable by its group or others unless sticky, as
    `/tmp` is, where no one can move an entry they do not own. A trailing `/` cannot hide a
    final link, and `..` leaves a link's target, not the link (#179's CI review). The check
    reads mode bits, not ACLs. A missing dir is made, `0700` whatever the umask, so the one
    pup makes passes the same check. A dir that fails any check throws
    `ConfigDirRefusedError`. `pup new`, `pup audit --sweep`, `pup launch`,
    `pup conductor start`, `pup respawn` and `pup kill --respawn` resolve the dir before
    anything is planned, steered, killed or opened, and refuse in one scrubbed line. `pup fix`
    refuses through its own scrubbed catch, before its round starts. A window reads the list
    once, so its `-e` and the `.claude.json` its trust is seeded in agree on the dir. Those
    commands hash that dir for the drift check instead of `~/.claude`. `transcriptDir` takes
    the dir.
    *Owed, outside this change's scope.* `session-lifecycle.service.ts` stamps a session's
    `transcript_path` as `transcriptDir(worktree)` and `dashboard.service.ts` checks the
    stored column against the same call, both on `~/.claude`. A session on a named config dir
    writes its transcript where neither looks, so the dashboard shows none for it until both
    pass `claudeUserDir(repoPath)`. `pup ui` (`actions.service.ts`) launches, starts the
    conductor and respawns on `~/.claude`. A UI launch on a named dir records the hash of
    `~/.claude`. A refused dir throws from inside `launchSession`, after the worktree is cut
    and the row inserted, and a UI respawn throws after the kill. The hash and the window
    still read the list separately, the launching command once and the window once, so a
    session that rewrites the file between the two can split them across dirs. Closing that
    means resolving the list once where the command starts and passing it down through
    `session-lifecycle`, `session-handoff`, `fix-round` and `conductor` to the window. The
    `claude -p` utilities (`utility.service.ts`) that the conductor's `pup merge --pr` starts
    inherit the conductor's environment, named variables included. A named
    `CLAUDE_CONFIG_DIR` puts them on that dir's settings and login too.
    *Ceilings.* The values travel in tmux's argv, as every `-e` does, and `ps` shows them to
    the operator's own user. They are also readable per session by any other client of the
    same server, with `tmux show-environment -t =<session>` (verified on tmux 3.7b). Every
    session's window is on the default server, so every session can read every other
    session's values. The conductor's window is on its own socket, so its values are not
    readable from there. The list is closed to names that are configuration, not
    credentials, which is what makes that acceptable. The conductor may run `pup init`
    (decision 48), so it can widen the list, though only within the five. What Claude Code
    makes of a named `CLAUDE_CODE_EFFORT_LEVEL` beside the `--effort` decision 92 passes is the
    operator's call, and pup does not check it.
    *Tests.* In `session-runtime.test.ts`, every name off the list is refused and named: the
    peer channel, the credentials, the nested-session marker and session ids, the loaders,
    git's redirects, `HOME`, `PATH`, `__proto__` and the empty name. The five are taken. A
    saved list reads back, leaves no staged copy, and a name off the list written in by hand
    is dropped. A file that does not parse, is no list, is past the cap, is a symlink, a fifo
    or a directory reads as no names, without blocking. `claudeUserDir` is `~/.claude` until
    the list names `CLAUDE_CONFIG_DIR` and the shell has it, and refuses a `~`, a relative
    or an empty value. It refuses a dir root owns, a link to one, a group- or others-writable
    dir and a file, and makes a missing one, and its parents, `0700`. A launch hands the
    window each named variable with the shell's value, sets none for an unset name, gives
    tmux's client environment none of them, and seeds trust in the named dir's `.claude.json`.
    An unnamed `CLAUDE*` variable stays stripped from both. The launch's own argv and client
    environment, run against the installed tmux, set the variables on the window, values
    ending in `;` and `\;` included, and leave every `CLAUDE*` name out of
    `show-environment -g`. The conductor's window is
    handed the variable and seeded in the same dir. `transcriptDir` derives its segment under
    a named dir. In `index.test.ts`, `init --session-env` refuses each family, naming it and
    the five, and stores neither the list nor the origin. It records a list, keeps it over a
    plain `init`, and clears it on `""`. `pup new`, `pup launch`, `pup conductor start`,
    `pup fix`, `pup respawn` and `pup kill --respawn` refuse a relative value in one scrubbed
    line. None of them plans, steers, kills or opens anything.
