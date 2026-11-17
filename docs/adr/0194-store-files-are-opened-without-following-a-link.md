# 0194. Store files are opened without following a link (2026-11-17)

- Status: accepted

194. **Store files are opened without following a link (2026-11-17).**
    *What was open.* The store lives under `~/.pupitre/<project>/`. A session runs with
    permissions bypassed (decision 5), and its Bash scope check is best-effort (decision 6), so
    a session can write there. pup opened the store's files by path. A session could replace
    one of them with a symlink and pup would read or write the file the link points at. The
    files at risk were `state.db` and its `-wal`, `-shm` and `-journal`, a profile layer, the
    compiled profile under `sessions/<id>/compiled/` (with `hooks/scope-in.pat` and
    `settings.json`), `handoff.md`, `brief.md` and `events.jsonl`. Two cases were the worst.
    When SQLite cannot read a WAL as one, it truncates and rewrites it, so a hard-linked `-wal`
    let the next pup command overwrite another of the operator's files. A `compiled` directory
    swapped for a link to `~/.claude` would have the next respawn write its `settings.json`
    there.
    *The rule.* pup opens a store file only as a regular file it reached without following a
    link. It writes one only by creating a fresh file in place of whatever stood there.
    - `openStore` lstats `state.db` and its `-wal`, `-shm` and `-journal` before SQLite opens
      them. Each must be absent, or a regular file with exactly one link. Otherwise the open
      throws and names the file. better-sqlite3 cannot pass `SQLITE_OPEN_NOFOLLOW`, so the check
      runs before the open. SQLite never creates a hard link, so a second link means something
      other than pup put the file there. `listRegisteredProjects` runs the same check before it
      opens each project's store read-only, and lists a store that fails it as unreadable.
    - Every read uses `readPlainFile(path, { followLinks: false, soleLink: true })` (decision
      96) or the same checks: `O_NOFOLLOW | O_NONBLOCK`, then a regular file with exactly one
      link, checked on the descriptor. O_NOFOLLOW lets a hard link through, so the link count
      is checked as well. This covers profile layers, `brief.md`, `handoff.md`, the respawn's
      `context.md`, the conductor's `max-sessions` and blocked-since files, the shift-left
      setting and the dashboard's `events.jsonl`. `soleLink` is opt-in rather than part of
      `followLinks: false`. A test slot is taken by a hard link, so it has two names while the
      take is in progress. A reader that refused it would count the slot as a dead holder's and
      reclaim a live one. When a file is absent, the reader checks with lstat, not exists, so a
      dangling link reaches the refusal. Otherwise `pup profile show base` would fall back to
      the built-in base, and `pup brief edit` would write the template through the link.
    - Writes go through `writeStoreFile` (`paths.utils.ts`): the compiled profile,
      `brief.md`, the conductor's `max-sessions` and the retro reports. It creates a randomly
      named temp file in the same directory with `O_CREAT | O_EXCL | O_NOFOLLOW`, writes and
      fsyncs it, then renames it over the target. A rename replaces a link, symbolic or hard,
      without following it. A reader sees the old file or the new one, never part of one. A
      directory at the target fails the rename, and the temp file is removed. A mode such as a
      hook script's or a retro's `0600` is set on the descriptor. One write does not go
      through it: the conductor's blocked-since file is removed and then created with `wx`.
      That is safe too, because an `O_EXCL` create never follows a link. `writeCompiledProfile`
      also refuses its output directory, and every directory below it, when what stands there
      is not a real directory.
    - `ensureBrief` hands the brief to `$EDITOR` only when it is a regular file with one link.
      An editor that saves in place would otherwise write through a hard link to the other
      file.
    - The refusal fits the reader. The store, a profile layer, the brief, the handoff and the
      respawn's context throw and name the file. The handoff's message says to remove the file
      and write the handoff again. The dashboard gives that session's row no activity and keeps
      the rest of the view, because one session's planted link must not take down the whole
      dashboard.
    *Known gaps.*
    - Two checks race with the open that follows them. `openStore` lstats `state.db` and its
      companions before SQLite opens them by path. `writeCompiledProfile` lstats each compiled
      directory before it writes into it. A writer that swaps a file or a directory between
      the check and the open still gets through. O_NOFOLLOW covers only the last component of
      a path, and Node has no `openat` to open a file relative to a directory descriptor that
      was already checked. A session can also trigger `openStore` itself through pup commands,
      so it can retry the race as often as it likes.
    - The real fix is containment, not checks. The session's sandbox should deny writes to
      `sessions/<id>/compiled/` and to `state.db*`, so it cannot plant anything there at all.
    - Only directories from the compiled profile's output directory down are checked. A link
      in place of `sessions/<id>`, `sessions` or the project root still redirects every path
      below it. pup then creates fresh directories under the link's target and writes its
      fixed file names there.
    - One store reader does not set `soleLink` yet: the plan usage file (decision 156). It
      still refuses a symlink. A hard link there only lets pup read a file that the same user
      could read anyway.
    - Two accepted lows. `findStalledSessions` `statSync`s `events.jsonl` to tell whether a
      running session has stalled, and that follows a link. The worst outcome is a wrong stall
      reading for one session. `ensureBrief` checks the brief with lstat and then hands the path to `$EDITOR`, which
      opens it by name. A link planted between the two is opened by the operator's editor,
      in front of the operator.
    *Cost.* An operator who keeps profile layers or the brief as symlinks into a dotfiles
    repository must copy them in instead. The same goes for a hard link. A store file is a new
    inode after each rewrite, not the old one overwritten. Each write costs an fsync.

## Amendment (2026-11-17)

The rule's list of writes said only the blocked-since file skips `writeStoreFile`. Five more
store writes skip it as well.

- The compiled hooks append to `sessions/<id>/events.jsonl` with the shell's `>>`. These are
  `hooks/event-log.sh` on PostToolUse, Stop and Notification, and the Bash re-check script's
  `scope_violation` line (`profile-compiler.service.ts`). `>>` opens with `O_APPEND | O_CREAT`
  and no `O_NOFOLLOW`, so it follows a link. A link planted at `events.jsonl` makes every hook
  call append one JSON line to the file the link points at. Part of that line is the tool
  input, which the session controls. The hook runs in Claude Code's process, outside the
  Bash sandbox. Only the dashboard's read of the file refuses the link. This gap is worth
  closing, and a follow-up task covers it.
- `writeRenamed` (`src/claude/session-runtime.service.ts`) writes `session-env.json` at the
  project root, `sessions/<id>/pane-pid`, `conductor/pane-pid` and the socket record
  `sessions/<id>/tmux-socket`. It writes a temp file named `<target>.<uuid>.tmp` with plain
  `writeFileSync` and renames it over the target. The rename replaces a link at the target
  without following it. The random name leaves no temp path to plant a link at in advance.
  It differs from `writeStoreFile` in three ways. It does not fsync. It does not remove the
  temp file when the rename fails. Its `mkdirSync({ recursive: true })` follows a link in
  place of a parent directory. `recordWindowSocket` refuses a symlinked session directory
  before it writes, but the pane-pid writes do not check, and neither does the conductor's
  directory. A linked parent is the gap already listed for `sessions/<id>` and the project
  root. This is an accepted low. A torn or stale pid or socket record affects only the
  session that owns it.
- The status line script `hooks/statusline.sh` writes `usage.json` by creating a temp file
  with `mktemp "$USAGE.XXXXXX"`, which is an `O_EXCL` create. It then runs `mv -f` over
  the target. The rename replaces a link at the target rather than writing through it. It
  does not fsync. This is accepted.
- The Bash re-check script (`profile-compiler.service.ts`) keeps its before-snapshot under
  `sessions/<id>/compiled/bash-snapshots`. It creates that directory at hook time, after the
  compile-time directory checks have run, with `mkdir -p`, which follows a link in place of
  `bash-snapshots`. It then makes a scratch directory there with `mktemp -d`, moves the
  before-snapshot to `bash-snapshots/<tool_use_id>` with `mv`, and later deletes it with
  `rm -f`. `mktemp -d` creates a fresh directory with a random name. `mv` replaces a link
  to a file at the target, but a link to a directory makes it move the snapshot into that
  directory. `rm -f` removes a link, not its target. So a planted link can only move the
  directory, or one snapshot of the session's own dirty paths, to where the link points.
  It does not write through to an existing file. This is an accepted low.
- `pup map --open` writes `map.html` at the project root. `pup report` writes `report.html`
  there and one dossier HTML per session, named by `dossierFileName`
  (`src/cli/index.ts`). All three use plain `writeFileSync`, which opens with
  `O_WRONLY | O_CREAT | O_TRUNC` and no `O_NOFOLLOW`. A link planted at any of these names
  makes the operator's command truncate the file the link points at and fill it with the
  rendered HTML, which carries session-controlled text. The command runs as the operator,
  outside any sandbox. This gap is worth closing, and a follow-up task covers it.

Writes outside the store are not part of this rule. These are the test slots under
`~/.pupitre/slots` (an `O_EXCL` stage, then a hard link), the intents under the repository,
the merge lock under `.git`, the gate child's sandbox profile in an `mkdtemp` directory, and
`preseedTrust`'s `~/.claude.json`.
