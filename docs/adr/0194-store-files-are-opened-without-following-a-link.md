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
    - Every write goes through `writeStoreFile` (`paths.utils.ts`): the compiled profile,
      `brief.md`, the conductor's `max-sessions` and the retro reports. It creates a randomly
      named temp file in the same directory with `O_CREAT | O_EXCL | O_NOFOLLOW`, writes and
      fsyncs it, then renames it over the target. A rename replaces a link, symbolic or hard,
      without following it. A reader sees the old file or the new one, never part of one. A
      directory at the target fails the rename, and the temp file is removed. A mode such as a
      hook script's or a retro's `0600` is set on the descriptor. `writeCompiledProfile` also
      refuses its output directory, and every directory below it, when what stands there is
      not a real directory.
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
