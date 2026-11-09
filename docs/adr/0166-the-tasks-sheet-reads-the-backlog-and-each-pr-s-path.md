# 0166. The Tasks sheet reads the backlog's overlaps and each PR's path through the gate off the events table (2026-11-09)

- Status: accepted
- Amends: [0098](0098-pup-dashboard-is-a-set-of-sheets-figures.md)

166. **The Tasks sheet reads the backlog's overlaps and each PR's path through the gate off the
     events table (2026-11-09).**
     Amends decision 98, which left Tasks to its own task. The bar now reads Overview, Health, Debt,
     Tasks, and `?sheet=tasks` serves it under everything decision 98 kept from decision 91: the
     token and Host guard, GET only, the CSP, nothing loaded from elsewhere, its own stream.
     *Gate runs.* A gate run is a `gate_result` event that carries a report: the first gate, each
     rejection, each refusal and each re-gate leave one, while a bare transition and the block
     after a rejection leave none. Over the last eight weeks, ending with today in UTC as the
     Overview's merges do, a column chart gives each week's share of runs that passed, a week with
     none printing "no run" rather than a 0% it did not earn; a rows chart ranks the stages that
     failed runs, a failed run counting once under each stage it records as `fail` or `flagged`,
     so a soft flag that refused a merge is charted where it stopped it. Both go through
     `chart.utils.ts` with their title and figure line, and the lead line says how many runs and
     how many passed; a window with no run is one line for the section.
     *Backlog.* `listBacklogTasks` in its order, each with the first sentence of its goal (up to
     the first `.`, `!` or `?` before a blank or the end, read off the scrubbed line), its scope-in
     globs and its scope-out, and the live sessions it would share files with. An overlap is read
     as a launch reads it (`scopeConflicts`, decision 99): each scope resolved against the tracked
     files by the gate's own rule (`scopedPaths`), a live session being one in a holding state, of
     this project. The sheet does its own resolution rather than call `scopeConflicts` per task,
     which would list the repo once per task on every poll: one `git ls-files` per render, none
     when the backlog or the live sessions are empty, and every spec read through
     `taskSpecForDisplay`, so a torn row degrades to no scope rather than ending the sheet. A
     listing git refuses is said once, in place of every task's overlaps.
     *Sessions.* Each session whose `merge` event carries a PR url, the newest first merge first.
     Read in event order: its gate runs and how many failed; its steers, every one but the
     `kickoff` that launched it, so a gate-rejection re-steer counts with the operator's and the
     conductor's; its `respawn` events; its re-gates, the gate runs after its first `merge` event,
     which decision 86's re-gate on a PR's new head is the only source of; and the time from its
     launch (`sessions.created_at`) to its first `merge`, when the PR opened, and to its first
     `landed`, when `pup land` brought it in, "not landed" until then. A local merge opens no PR
     and has no land after it, so it is left off the table; its gate runs still count in the
     charts.
     *Rejected.* Overlaps by comparing glob text: two globs can share files without sharing a
     prefix, and the launch already answers the question against the tracked files. The radar's
     stored overlaps: they pair live sessions by their diffs, and a backlog task has no diff yet.
     Counting re-gates from the `regated` outcome: the store keeps no such flag, and the run after
     the first merge is the one decision 86 describes.
     *Hardening.* The sheet is re-rendered on each poll a stream is open on: one events query of
     five types joined to this project's sessions, decoded through `decodeEvent`, so a torn
     payload is a run without a report and not an error; one backlog query; and the one listing.
     Every store string, the task id, goal, globs, file paths, stage names and PR urls, goes
     through `sanitizeReason`, `displayText` and `escapeHtml`; a session id prints as
     `(unminted session id)` outside the minted shape, and a PR url is a link only in a pull
     request's shape.
     *Tests.* In `web-dashboard-tasks.test.ts`, an empty store shows a hint per section and no
     SVG; a fixture session with a failed gate, its re-steer, a message, a respawn, a pass, a PR,
     a re-gate and a land counts 3 runs (1 failed), 2 steers, 1 respawn and 1 re-gate with its two
     times; a local merge and a live session stay off the table and the newest merge leads; the
     weekly pass rate and the failing stages read back from the figure lines, a run outside the
     window counting in neither; the backlog keeps store order, cuts each goal to its sentence and
     shows both scopes; a task sharing files with two live sessions names both, a merged session
     none; a repo git cannot list says so once; and markup and C0/C1 controls planted in a task id,
     goal, glob, tracked file name, stage and PR url reach the page escaped or not at all. In
     `web-dashboard.test.ts`, the bar links all four sheets and the empty store renders the Tasks
     sheet's hints.
