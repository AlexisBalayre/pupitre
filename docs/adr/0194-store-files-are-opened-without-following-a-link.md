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
      other than pup put the file there.
    - Every read uses `readPlainFile(path, { followLinks: false })` (decision 96) or the same
      flags: `O_NOFOLLOW | O_NONBLOCK`, and a regular file checked on the descriptor. This
      covers profile layers, `brief.md`, `handoff.md`, the respawn's `context.md` and the
      dashboard's `events.jsonl`. When a file is absent, the reader checks with lstat, not
      exists, so a dangling link reaches the refusal. Otherwise `pup profile show base` would
      fall back to the built-in base, and `pup brief edit` would write the template through the
      link.
    - Every write goes through `writeStoreFile` (`paths.utils.ts`). It unlinks the old entry,
      which never follows a link, then creates the file with `O_CREAT | O_EXCL | O_NOFOLLOW`. If
      an entry is put back between the two steps, the create fails and nothing is written
      through it. A hook script's mode is set on the descriptor. `writeCompiledProfile` also
      refuses its output directory, and every directory below it, when what stands there is
      not a real directory.
    - The refusal fits the reader. The store, a profile layer, the brief, the handoff and the
      respawn's context throw and name the file. The dashboard gives that session's row no
      activity and keeps the rest of the view, because one session's planted link must not take
      down the whole dashboard.
    *Known gaps.* The lstat in `openStore` and SQLite's open are two separate steps. A writer
    that swaps a file between them still gets through. Closing that window needs an open flag
    that the binding does not expose. Only directories from the compiled profile's output
    directory down are checked. A link in place of `sessions/<id>`, `sessions` or the project
    root still redirects every path below it. pup then creates fresh directories under the
    link's target and writes its fixed file names there.
    *Cost.* An operator who keeps profile layers or the brief as symlinks into a dotfiles
    repository must copy them in instead. A compiled file is a new inode after each rewrite,
    not the old one overwritten.
