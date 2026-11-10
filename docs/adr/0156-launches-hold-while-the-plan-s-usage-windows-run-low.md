# 0156. Launches hold while the plan's usage windows run low (2026-11-08)

- Status: accepted
- Amends: [0096](0096-test-runs-queue-for-a-few-machine-wide.md)

156. **Launches hold while the plan's usage windows run low (2026-11-08).**
    A Max plan meters usage in a 5-hour window and a 7-day window. Before this, pup launched
    into an exhausted window: the conductor kept the cap full, and every new session hit the
    limit mid-turn and stalled with work half done.
    *The reading.* Every compiled window, sessions and the conductor alike, gets a `statusLine`
    command, `hooks/statusline.sh` in its compiled dir. Claude Code hands it the statusline JSON
    on stdin, and the script copies `rate_limits.seven_day`, the window's `used_percentage`
    and `resets_at` and nothing else, to `usage.json` under the
    project's store dir. It writes through a temp file `mktemp` creates and a rename, so a
    reader never sees half a file and a planted temp name is never written through. A JSON
    without the window (a plan without it, or before the session's first response) leaves
    the file as it was. The reading's age is the file's mtime, so the file holds only what the
    JSON said. The script then prints one line, `ctx N% | 7d N%`, which replaces the
    operator's own status line in pup's windows.
    *The hold.* `pup launch` and `pup new` refuse a launch while a fresh reading has the 7-day
    window at or over 90%. They ask right after the session
    cap, before `pup new` writes its task. The refusal names the window, its share and its reset
    time in UTC. The conductor launches through `pup launch`, so it is held too, and its kickoff
    says so. `--over-limit` lifts the hold for the operator alone, like `--over-cap`: the
    conductor passing it is refused at the CLI and ignored in the lifecycle. A fix round and a
    respawn are not held: they carry work already started, and a hold would strand it.
    *Unknown never holds.* A reading older than 30 minutes, a missing or malformed file, a
    window whose `resets_at` has passed, and a file dated more than a minute in the future all
    count as unknown and hold nothing. The file is read as `maxSessions` reads its own: a link
    is never followed and a fifo never opened. The status line runs only when a window has
    something to show, so an idle fleet's reading goes stale. That is the intent: a quiet fleet
    has nothing to protect, and the next window to talk to Claude writes a fresh reading.
    *`pup status`* prints `usage: 7d N% (resets …); read Nm ago` after the
    conductor line, and adds `stale: holds nothing` past 30 minutes. Without a reading it prints
    no line.
    *Security.* The script quotes one path, the usage file's, which pup derives from the store
    root and the project id and checks shell-safe as it checks every path a hook quotes.
    Nothing from the task, the brief or the JSON reaches the shell except as jq's input, and
    jq keeps only numbers. Any window can write the file, a session included, so a session can
    hold launches or lift the hold. Neither does more than the operator's `--over-limit` or a
    wait undoes, and a session can already spend usage directly, so the reading is trusted for
    exactly two numbers and nothing else.
    *Ceilings.* The thresholds are constants, not configuration: one plan, one operator, until a
    second plan shape asks for another. Claude Code drops a window from the JSON once it resets,
    so the file can keep a window the JSON no longer carries. The reset check is what keeps
    that window from holding.
    *Tests.* The compiled script, fed sample statusline JSON, writes only the 7-day window's
    fields, prints one line and leaves no temp file. Hostile or non-JSON input writes nothing
    and runs nothing. A launch at 90% of the 7-day window is refused with the window and its
    reset named. `--over-limit` lets the operator through and never the conductor. A stale,
    missing, malformed, future-dated or reset reading never holds. `pup status` prints the
    share and the age.
    *Amended 2026-11-09: the 7-day window only.* The plan dropped its 5-hour window, so Claude
    Code's statusline JSON carries only `rate_limits.seven_day`. The script copies and prints
    that window alone, the hold reads it alone, and `pup status` names it alone. A `five_hour`
    window that ever reappears in the JSON or in an old `usage.json` is ignored: reading it
    would take back the code this amendment removes.
