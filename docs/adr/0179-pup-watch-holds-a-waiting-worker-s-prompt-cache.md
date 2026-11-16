# 0179. `pup watch` holds a waiting worker's prompt cache before its hour runs out (2026-11-13)

- Status: accepted
- Amends: [0035](0035-a-running-session-is-stalled-by-events-file.md)

179. **`pup watch` holds a waiting worker's prompt cache before its hour runs out (2026-11-13).**
    A worker's prompt cache lives an hour from its last request. The retro of 2026-11-09
    (decision 150) counted 93 worker requests that came after a longer idle and wrote the whole
    context back at the write price: 8.6 million tokens, about 84 USD in a week, around 93k
    tokens each. Most came after `pup session done` or `pup session ask`. Those windows are sure
    to be woken (a gate refusal, a review, an answer), but nobody knows when.
    `holdIdleCaches` (`src/core/cache-hold.service.ts`) rides the watchdog sweep `pup watch`
    already runs (decision 35's addendum), after the resumes and before the conductor nudge, and
    is skipped with the rest of the sweep in a dormant project (decision 62). It holds a worker
    that waits on someone else. That means `awaiting-review` (the gate or a review wakes it) and
    `running` with a question nobody has answered yet (decision 76, read by the inbox's own
    `openQuestion`). A running worker with no open question waits on no one pup can name, so it
    is left to the stall rule. A `blocked` worker is never held, though it waits on the
    operator's unblock. A hold is a full turn, and only its wording asks the worker to run no
    tool. A session parked by the gate or by a human, perhaps for a safety reason, is to take no
    turn until a human unblocks it. Its cache lapses, and its unblock pays the write once.
    The clock is the session's events file, the one the stall rule reads (decision 35). Its mtime
    trails the last request by the idle notice Claude Code fires a minute after a turn ends. A
    hold comes once the file has been quiet 50 minutes (`CACHE_HOLD_AFTER_MS`) and never past
    58 (`CACHE_HOLD_UNTIL_MS`), since by then the cache may have gone and a hold would pay the
    write it exists to avoid. The eight minutes between cover a slow sweep and a paste. The hold
    is made only when the hook events show the turn ended, and only into an empty input box: a
    draft is the operator's, and a hold must never clear or send it. The hook events alone cannot
    show a turn that has just started. The worker profile has no hook on a submitted prompt, so a
    turn started by a steer, a respawn or an earlier hold moves the file only at its first tool
    or at its end. Until then the tail still ends on the last Stop. The input box is drawn while
    a turn runs, so it reads empty too. A hold is therefore refused while a prompt (`steer`,
    `respawn` or `cache_hold`) is recorded at or after the file's mtime, compared to the whole
    second `created_at` keeps. That keeps a hold out of a turn that a steer, a peer's message or
    the same sweep's resume has just started. It also stops a hold being typed again every sweep
    while the last hold's turn runs, or in the minute after that turn died, before the idle
    notice (below) moves the file and the 50 minutes start again. It is pasted and submitted
    like a steer (decision 45). A box that refuses the paste is cleared, nothing is recorded, and
    the next sweep tries again while the window lasts. Enter can land while the UI still folds
    the paste, so a box that still holds text after it gets one Enter more, as a tell's does
    (decision 85). A box gone from the screen gets none, since Enter there picks a dialog's
    option, and counts as sent, as it does for a steer. A hold still in the box after the second
    Enter is not recorded. Recorded, it would refuse every later hold of the window while its
    cache lapsed. It stays in the box, where an operator who attaches finds it, until they or a
    steer clear it. The window is held again once its box is empty. The text (`CACHE_HOLD_MESSAGE`) tells the
    worker that nothing changed and that this answers nothing it asked, and asks it to run no
    tool and reply `held`.
    The look at the box, the paste and the Enter are three tmux calls, not one step, the race a
    steer and a tell already accept (decisions 45, 85). If the operator types into the window
    between the look and the paste, the box never shows the hold whole, so it is cleared with
    their keystrokes in it and nothing is submitted. Keys typed between the paste and the Enter
    are submitted with the hold. The window is seconds long, in a pane that has been quiet for
    50 minutes.
    The events file is the session's to write, and the sweep that reads it also resumes dead
    turns and nudges the conductor, so it is read like a file the session may have replaced. It
    is opened without following a link and without blocking. Only a regular file counts, and its
    mtime is taken from that open descriptor, not from a separate `stat`. Only its last 1 MiB
    (`CACHE_HOLD_EVENTS_TAIL_BYTES`) is read, with the line the cut tore dropped. A quarter of the
    events files on the machine this was built on were over 1 MiB (the largest 18 MB), so refusing
    a big file outright would leave the longest, dearest windows unheld. Reading newest first
    needs only the turn that ended. One session's failure, whether a link, a directory, a fifo,
    a pane tmux cannot reach or a refused store write, skips only that window's hold. It never
    stops the rest of the sweep. A store write refused after the paste leaves a hold typed but
    unrecorded. The next sweep can then type it again before the first hold's turn moves the
    file, queueing a duplicate behind it. The watchdog's resume accepts the same gap.
    A hold is recorded as a `cache_hold` event with the idle it ended and the events file's size
    (below), never as a `steer`.
    `openQuestion` does not read it, so a question stays open and in Needs-you until the
    operator answers it (decision 93), and the window's last steer stays one that was actually
    sent to it.
    A window is held at most eight times in a row (`CACHE_HOLD_LIMIT`), counted as the
    `cache_hold` events since anything else was recorded for the session. After that it is left to
    lapse until something else is recorded, such as a state change or a steer. A hold reads the
    context at a tenth of the input price, and a one-hour cache write costs twice it. Eight holds
    therefore cost 0.8 of the input price, under half of the one re-write they avoid. That covers
    a working day of holds. A window left overnight pays the write once, when it wakes, instead
    of paying holds all night.
    The cap is a cost control, not a boundary. The session controls both inputs: it moves the
    events file's mtime with every hook it fires, and it can record another event itself (a
    `pup session ask`, a hooked tool call), which starts the trailing count again. A worker that
    keeps doing so is held indefinitely, at one hold per 50 minutes of quiet, a tenth of its
    context each. That is the most it can make pup spend, far less than it could spend with
    turns of its own.
    The cost to the stall rule, which this amends: each hold's turn moves the events file. So a
    running worker held over an open question no longer stays stalled once it passes ten minutes.
    Its stall age starts again after each hold, about every 51 minutes. The question itself
    stays in Needs-you, which is where the operator acts on it. Each hold also adds two short
    messages to the worker's context.
    A hold's turn can die like any other (decision 35's addendum). It then ends on the API error
    the watchdog resumes, and that resume would tell a worker waiting on its question to finish
    the task without the answer. The newest recorded prompt alone cannot say the turn that died
    is the hold's: the operator may answer by typing into the window by hand, and `pup unblock`
    types nothing (decision 7), so neither records a prompt. Nor can the file's mtime. A dead
    turn fires no Stop, but Claude Code still sends its idle notice about a minute later, unless
    a new prompt comes first. This was checked on 2026-11-14 against the machine's worker
    transcripts and events files. Of 19 worker turns that died on an API error, 15 had an
    `idle_prompt` with no Stop before it as the next line of their events file. The other 4 got
    their next prompt within 25 seconds of the error. So decision 35's addendum, which says the
    file stops dead, holds only from that notice on: a dead turn moves the file once, a minute
    after it dies. A hold whose turn died and a hold whose turn ended both leave the mtime about
    a minute after the hold. What tells them apart is a Stop. The hold records the events file's
    size as it stood when the hold was typed (`eventsBytes`), the offset where its turn's hooks
    start, and the watchdog (`isHoldTurnOpen`) leaves a dead turn alone only when the newest
    prompt recorded is a hold and no Stop follows that offset. The question stays in Needs-you.
    A turn that dies after the hold's turn ended has the hold's Stop before it, so it is resumed
    as before, whoever prompted it. A hold's turn that ran a tool before it died has no Stop
    either, so it is left alone too. The watchdog reads the file as the hold does: no link
    followed, no blocking, a regular file only, and no more than `CACHE_HOLD_EVENTS_TAIL_BYTES`
    past the offset. A file it cannot open, one shorter than the offset (replaced), and one with
    more than that past the offset (moved on, since a turn that ran no tool writes a line or
    two) cannot be read as the hold's turn, so they are resumed. One edge stays open: if the
    operator types into the hold's dead window by hand and that turn dies too, no Stop separates
    it from the hold's, and it is left alone. Its question is still in Needs-you, and the
    operator who typed it is at the window.
    Rejected: respawning a window that will idle past the hour on a fresh one. The wake time is
    not known, so a respawn cannot be timed to it. A fresh window pays the first-request floor
    (about 22k tokens for a worker) plus everything it reads again to rebuild its context, and it
    loses what the old window knew; a hold costs a tenth of the context. Holding every idle
    running worker: one with no question open is stalled or waiting on its own work, and the
    stall rule's resume answers that. Holding the conductor and the operator's own console:
    their idle has no state pup can read to tell a wait from a finished day, and both are the
    operator's to type into. A clock taken from the transcript: it is not the file the stall
    rule reads, and two clocks would disagree on one window.
