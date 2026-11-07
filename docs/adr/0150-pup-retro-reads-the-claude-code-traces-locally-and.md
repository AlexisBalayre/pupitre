# 0150. `pup retro` reads the Claude Code traces locally and writes only counts (2026-11-07)

- Status: accepted

150. **`pup retro` reads the Claude Code traces locally and writes only counts (2026-11-07).**
    `pup retro [--since <days>] [--json] [--out <dir>]` reads the Claude Code transcripts of the
    project's sessions (the same files `pup usage` reads, through one shared scan) and ranks where
    the tokens went: tool output carried by size bucket, cache hit rate and idle re-caches per
    session class, compactions and the first-request floor, and files read three or more times in
    one session. Each finding names its signal, a number, why it costs and a candidate fix.
    The traces hold prompts, commands and file contents, so the report is built from an
    allowlist. It carries tool names, size buckets, counts, token numbers and repo-relative file
    paths made of `[A-Za-z0-9_:.@+/-]`. A path outside the repo is reduced to its basename. No
    prompt, command, tool output or message text enters the report type, and the serializer
    copies named fields only. The files are written owner-only (directory 0700, files 0600) as
    `retro-YYYY-MM-DD.md` and `.json` under `~/.pupitre/<project>/retro/` by default, and nothing
    is sent anywhere. Only the operator may run it: a worker or the conductor is refused.
