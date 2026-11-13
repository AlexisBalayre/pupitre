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
    that waits on someone else. That means `awaiting-review` (the gate or a review wakes it),
    `blocked` (the operator's unblock does), and `running` with a question nobody has answered
    yet (decision 76, read by the inbox's own `openQuestion`). A running worker with no open
    question waits on no one pup can name, so it is left to the stall rule.
    The clock is the session's events file, the one the stall rule reads (decision 35). Its mtime
    trails the last request by the idle notice Claude Code fires a minute after a turn ends. A
    hold comes once the file has been quiet 50 minutes (`CACHE_HOLD_AFTER_MS`) and never past
    58 (`CACHE_HOLD_UNTIL_MS`), since by then the cache may have gone and a hold would pay the
    write it exists to avoid. The eight minutes between cover a slow sweep and a paste. The hold
    is made only when the hook events show the turn ended, and only into an empty input box: a
    draft is the operator's, and a hold must never clear or send it. It is pasted and submitted
    like a steer (decision 45). A box that refuses the paste is cleared, nothing is recorded, and
    the next sweep tries again while the window lasts. The text (`CACHE_HOLD_MESSAGE`) tells the
    worker that nothing changed and that this answers nothing it asked, and asks it to run no
    tool and reply `held`.
    A hold is recorded as a `cache_hold` event with the idle it ended, never as a `steer`. A
    steer answers an open question, and a hold must leave that question open, in Needs-you, and
    out of the window's last steer.
    A window is held at most eight times in a row (`CACHE_HOLD_LIMIT`), counted as the
    `cache_hold` events since anything else was recorded for the session. After that it is left to
    lapse until something else is recorded, such as a state change or a steer. A hold reads the
    context at a tenth of the input price, and a one-hour cache write costs twice it. Eight holds
    therefore cost 0.8 of the input price, under half of the one re-write they avoid. That covers
    a working day of holds. A window left overnight pays the write once, when it wakes, instead
    of paying holds all night.
    The cost to the stall rule, which this amends: each hold's turn moves the events file. So a
    running worker held over an open question no longer stays stalled once it passes ten minutes.
    Its stall age starts again after each hold, about every 51 minutes. The question itself
    stays in Needs-you, which is where the operator acts on it. Each hold also adds two short
    messages to the worker's context.
    Rejected: respawning a window that will idle past the hour on a fresh one. The wake time is
    not known, so a respawn cannot be timed to it. A fresh window pays the first-request floor
    (about 22k tokens for a worker) plus everything it reads again to rebuild its context, and it
    loses what the old window knew; a hold costs a tenth of the context. Holding every idle
    running worker: one with no question open is stalled or waiting on its own work, and the
    stall rule's resume answers that. Holding the conductor and the operator's own console:
    their idle has no state pup can read to tell a wait from a finished day, and both are the
    operator's to type into. A clock taken from the transcript: it is not the file the stall
    rule reads, and two clocks would disagree on one window.
