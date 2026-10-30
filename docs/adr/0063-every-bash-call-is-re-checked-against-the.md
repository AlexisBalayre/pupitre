# 0063. Every Bash call is re-checked against the worktree after it runs (2026-09-21)

- Status: accepted
- Amended by: [0124](0124-the-worktree-hooks-reads-run-under-a-deadline.md)

63. **Every Bash call is re-checked against the worktree after it runs (2026-09-21).** Seen live
    on 2026-09-17 in session t-mtni8c6t. `src/cli/no-adapter-guard.utils.ts` and its test were
    outside the session's scope-in, both as stored and as compiled into `scope-in.pat`. The
    session changed both from Bash with a `python3` heredoc that called
    `open(path, 'w').write(...)`. No `scope_violation` was recorded, the edit went into the
    commit, and the merge gate's diff-vs-scope audit was the first thing that would have
    noticed. `bash-guard.sh` matches command text that looks like a write, and decision 41
    already stated the ceiling: editing is refused at admission only. No pattern list can name
    every interpreter heredoc (`python3`, `node`, `perl`, `tee`, `dd`, a redirection inside a
    subshell), so the list was left alone and the worktree is read instead.
    *The mechanism.* A new compiled hook, `bash-recheck.sh`, is registered for `Bash` at
    PreToolUse, next to `bash-guard.sh`, and at PostToolUse and PostToolUseFailure. A command
    that writes and then exits non-zero ends in the second of those, which is why both are
    wired. Before the call it writes a snapshot: one line
    `<fingerprint> <reason> <path>` per dirty path outside the scope, taken from
    `git status --porcelain=v1 -z --untracked-files=all --no-renames`. The fingerprint is the
    blob hash from `git hash-object --no-filters`, or `deleted`. The snapshot is stored under
    `<compiled>/bash-snapshots/<tool_use_id>`, so calls running in parallel each have their
    own. After the call it lists again and `grep -vxF` keeps the lines the snapshot does not
    have. That catches a file created, rewritten or deleted during the call, and leaves out a
    file that was already dirty and did not change. Each such line appends
    `{"type":"scope_violation", "path", "reason", "command", "pup_session_id"}` to the
    session's `events.jsonl` and prints
    `SCOPE VIOLATION: <path> (<reason>) was written by: <command>`. The hook then exits 2,
    which is decision 6's loud-backstop shape: the write has already happened, and the refusal
    is in front of the session on the same turn. The reasons are `protected-path` (`.claude/`,
    matched case-insensitively), `scope-out` and `outside-scope-in`, checked in the Edit/Write
    hook's order and against the same sidecar pattern files, so the Bash check cannot read a
    scope more loosely than the Edit/Write check does. `bash-guard.sh` stays as the cheap first
    line and was not changed.
    *Worktree names are data, never code.* Any file name in the worktree is chosen by the
    session. With `-z`, git gives each path raw. `tr` maps a newline inside a name to `\001`
    before it turns NUL into the line separator, so one record is always one line and a name is
    never split. From there a name is only ever a double-quoted variable: matched through
    `grep -f` on stdin, printed with `printf '%s'` (sh's `echo` would interpret a backslash),
    passed to git after `--`, and handed to `jq --arg`. It is never unquoted, never globbed and
    never in `eval`. `--no-filters` and `-c core.fsmonitor=` mean the check does not run a
    clean filter or an fsmonitor hook the session may have armed. A tool-use id that is not
    `[A-Za-z0-9_-]` is dropped rather than used as a file name. With no id the check compares
    against an empty snapshot, which is the loud direction. A payload that cannot be parsed is
    refused.
    *Hardened after the security review of 2cecd0a (2026-09-22).* The review reproduced three
    fail-open routes against the compiled hook, and each is now closed or stated. First, a
    fifo hung the check. `rm src/cli/decoy.ts && mkfifo src/cli/decoy.ts` beside an
    out-of-scope write left `hash-object` blocked on the fifo past the 5-second timeout, which
    fails open. Nothing was recorded, and because the fifo stayed, every later check hung too.
    Only a regular, non-symlink file is read now. Anything else is fingerprinted `special`,
    and a file over 64 MiB is fingerprinted `large-<bytes>` rather than hashed. Second, an
    ignore rule hid a protected write. `git status` never lists an ignored path, and the rule
    can be the session's own: a write to `.git/info/exclude` is invisible, since it is not a
    worktree path. So a second pass lists `.claude/` (`:(icase)`) with
    `--ignored=traditional` and keeps only its `!!` records, which are fingerprinted like any
    dirty path. Third, the re-check was not wired where a background shell's writes surface.
    It now also runs at PostToolUse on `TaskOutput`, since reading a background shell's or
    task's output is the next point the session looks at it. Claude Code's hooks reference
    confirms `PostToolUseFailure` (after a tool call fails, same `tool_use_id` as the pre
    call) and `TaskOutput` (deprecated in favour of `Read` on the task's output file, which
    this hook does not see; `BashOutput` no longer exists). That read has no snapshot of its
    own, so it compares against nothing: every dirty path outside the scope is flagged again,
    and the command is recorded as `a read of background output <tool_input>`. The budget is
    capped. More than 200 status records across both passes (`RECHECK_MAX_DIRTY_PATHS`) are
    not read at all: the check refuses with `SCOPE CHECK FAILED: over 200 dirty paths` and
    `Commit or clean the worktree`, failing closed. It already forked once per path, twice per
    call, under a timeout that fails open. The script also sets `LC_ALL=C`, so that BSD `tr`
    cannot drop a name that is not valid UTF-8. That line is defensive and untested: APFS
    refuses such names, and GNU `tr` reads bytes in any locale. The script's scratch
    directory is made under `<compiled>/bash-snapshots/`, not at `mktemp -d`'s default
    location. Under the merge gate's `sandbox-exec` that default was the system temp dir,
    which the sandbox refuses to write, so every pre-check exited 2 and the gate's test
    stage failed on the first run. That bug also showed the pre-check could block a call.
    A scratch dir that cannot be made now lets the call run, and the post-check refuses
    with `SCOPE CHECK FAILED`. The re-check tests were re-run inside a sandbox built with
    the gate's own `writeProfile` and `gateChildEnv`.
    *Tests,* in `profile-compiler.test.ts`, against the compiled hook on a real temp git
    worktree, run as Claude Code runs it (pre hook, then the command, then post hook), under
    a UTF-8 locale and killed at 4 seconds, so a hang fails the test. A
    `python3` heredoc that writes `src/cli/index.ts`, outside scope-in, is refused with exit 2,
    the path and the command on stderr, and exactly one `scope_violation` line. The same heredoc
    writing an in-scope file passes silently and records nothing. A new file in scope-out
    written by a command that then fails is refused at PostToolUseFailure. A deletion and a
    write into `.claude/` are refused with their reasons. A file dirty before the call passes an
    unrelated call and is refused once the call changes it. A missing or hostile tool-use id
    compares against nothing. A file named `-n $(touch pwned) ';x \ ` is refused and named in
    full, and `pwned` appears in no directory. A name with a newline is refused too. Settings
    wire the hook for Bash at all three events. The reviewer's fifo command is refused, and
    two later calls are still checked with the fifo in place. A `python3` write that excludes
    `.claude/` and then writes `.claude/settings.local.json` is refused as `protected-path`. A
    write made after a call's post-check is refused when background output is read. 201 new
    files refuse with no violation recorded. With `git` missing from PATH, or a `git` that exits
    128, the post-check refuses with `SCOPE CHECK FAILED` and the pre-check still lets the call
    run. It does the same when its scratch dir cannot be made.
    *The discriminating mutations*, each run against a backup copy of the service and
    restored from it: removing the post-check (an `exit 0` ahead of it) fails six tests,
    including the heredoc one; ignoring the snapshot fails two; dropping the PostToolUseFailure
    wiring fails one. Hashing every entry again without the regular-file guard, dropping the
    ignored `.claude/` pass, dropping the `TaskOutput` wiring, dropping the cap and
    exiting 0 on a git failure each fail exactly their own test.
    *Ceilings.* The violation is in the session's `events.jsonl`, not in the store's `events`
    table: no code path folds hook lines into that table, so `pup review`'s scope-violation
    count does not see it yet. That fold is a separate task in the CLI and the store, outside
    this scope. `path` and `command` are recorded raw, as the session wrote them: whatever
    folds or renders them sanitizes them there, per decision 29. The check reports and does
    not revert, and the merge gate's diff-vs-scope audit is still the authority.
    **A write that lands between one post-check and the next pre-check is never flagged**:
    the next snapshot takes it in as the baseline. That covers a Bash call with
    `run_in_background` (the tool returns at launch, so its post-check runs before the shell
    writes) unless its output is read through `TaskOutput`, which the wiring catches; read
    through `Read` on the output file, the route Claude Code now prefers, or never read, it is
    not. The same holds for a subagent: its writes are re-checked only when its output is read
    through `TaskOutput`, and otherwise never. Writes from MCP tools are never re-checked. The
    hooks and their snapshots are in the store, which a
    session's shell can reach (decision 57), so a session that sets out to defeat the check can
    do so. This closes the accidental route, not the adversarial one. A file whose name holds a
    control character is fingerprinted `unhashable`, and a fifo, device or symlink is
    fingerprinted `special`. Once one of these is dirty, a later rewrite of it is not noticed,
    and neither is a symlink pointed somewhere else; creating or deleting one still is. A file
    over 64 MiB rewritten at the same size is not noticed either. A file swapped for a fifo
    between the regular-file test and the read is read under the hook's deadline, which kills
    the read and fails the check as out of time (decision 124). Untracked output that is not
    gitignored and falls outside the scope (a coverage report, a cache) is refused like a write,
    because `git add -A` would commit it. Only `.claude/` is read past ignore rules: an ignored
    file elsewhere is not committed, so the gate never sees it either. A call interrupted
    before PostToolUse, or refused by `bash-guard.sh` after the snapshot has been taken (the
    two PreToolUse hooks run in parallel), leaves its snapshot file behind. More than 200
    dirty paths refuse every Bash call until the worktree is committed or cleaned, however
    many of them are in scope. The conductor's profile has no scope and does not get the
    hook.
