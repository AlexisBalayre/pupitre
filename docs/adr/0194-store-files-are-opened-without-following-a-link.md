# 0194. Store files are opened without following a link (2026-11-17)

- Status: accepted

194. **Store files are opened without following a link (2026-11-17).**
    *What was open.* The store lives under `~/.pupitre/<project>/`. A session runs with
    permissions bypassed (decision 5), and its Bash scope check is best-effort (decision 6), so
    a session can write there. pup opened the store's files by path. A session could replace
    `state.db`, its `-wal`, `-shm` or `-journal`, or a profile layer under `profiles/`, with a
    symlink. pup would then read or write the file the link points at. `-wal` is the worst case:
    when SQLite cannot read a WAL as one, it truncates and rewrites it. A hard-linked `-wal`
    therefore lets the next pup command overwrite another of the operator's files on the same
    volume.
    *The rule.* `openStore` lstats `state.db` and its `-wal`, `-shm` and `-journal` before
    SQLite opens them. Each must be absent, or a regular file with exactly one link. Otherwise
    the open throws and names the file. better-sqlite3 cannot pass `SQLITE_OPEN_NOFOLLOW`, so
    the check runs before the open. SQLite never creates a hard link, so a second link means
    something other than pup put the file there. A profile layer is read with
    `readPlainFile(path, { followLinks: false })` (decision 96). That call opens the file with
    `O_NOFOLLOW` and reads it only when the descriptor is a regular file. A refused layer
    raises `InvalidProfileError` and names the file. `pup profile show` checks whether the
    layer exists with lstat, not exists. A dangling `base.yml` link therefore reaches the
    refusal and does not fall back to the built-in base.
    *Known gap.* The lstat and SQLite's open are two separate steps. A writer that swaps a file
    between them still gets through. Closing that window needs a SQLite open flag that the
    binding does not expose. Other per-project files are still opened by path, and their code
    sits outside this change: the compiled profile under `sessions/<id>/compiled/` (with
    `hooks/scope-in.pat`), `handoff.md`, `brief.md` and the dashboard's read of
    `events.jsonl`. The usage file and the cache-hold reads of `events.jsonl` already open
    without following a link.
    *Cost.* An operator who keeps profile layers as symlinks into a dotfiles repository must
    copy them in instead.
