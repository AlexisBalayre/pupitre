# 0123. The Health sheet charts every gate metric across every snapshot, merges marked on the time axis (2026-10-29)

- Status: accepted
- Amends: [0098](0098-pup-dashboard-is-a-set-of-sheets-figures.md)

123. **The Health sheet charts every gate metric across every snapshot, merges marked on the time
     axis (2026-10-29).**
     Amends decision 98, which left Health to its own task. The Overview's sparklines draw the
     last eight captures; Health is where the whole history is read, and where a move is tied to
     the work that made it. The bar now reads Overview, Health, Debt, and `?sheet=health` serves
     it under everything decision 98 kept from decision 91: the token and Host guard, GET only,
     the CSP, nothing loaded from elsewhere.
     *What it reads.* Every `baseline_history` row (`listBaselineHistory`), each through
     `captureDebt`, now on the repository since two sheets read it, and `debtFigures`; and each
     session's first `merge` event, one grouped query ordered by its time, since a fix round's
     re-gate records another (decision 98). The metrics are the ones `debtFigures` reads, coverage,
     unused exports and duplicated lines, in one `GATE_METRICS` list the Overview's tiles share;
     a figure added there gets a chart here. A stage records pass, fail or skip and a duration,
     no gate figure, so it is not charted. A capture whose time does not parse has no place on the
     axis and is left out. Every time on the sheet is printed from the parsed instant, in UTC, so
     no stored time string reaches the page; the session id prints as `(unminted session id)`
     outside the minted shape, and a PR url goes through `sanitizeReason`, `displayText` and
     `escapeHtml`, and is a link only in a pull request's shape, as on the Overview.
     *Charts.* `timeLineChart` in `chart.utils.ts` places each capture by when it was taken, not
     evenly, so merges can be marked between them: each is a dashed rule across the plot at its
     moment, its hover naming the session, the time and the PR, and a link to the PR when there is
     one. A capture that left a figure unmeasured breaks the line, never a zero, and so does a
     duplication count stamped with another rule than the one before it (decision 39); every
     measured capture is a dot with its own `<title>`, so one standing alone between two gaps
     still shows. The figure line under it carries every capture, "not measured" in words. A
     metric no capture measured is one line in its chart's place, and an empty history is one line
     for the whole section.
     *Moves.* Each capture is compared, figure by figure, with the newest earlier capture that
     measured that figure comparably, so a gap hides no change. A move's size is its change over
     the larger of its two values, so a count and a ratio rank on one scale and a figure leaving
     zero counts in full; a capture ranks by its largest move, a tie going to the newer. The table
     lists the ten largest with every figure that moved, and names the sessions whose first merge
     falls after the earliest capture compared with and at or before this one, newest first, five
     at most then how many more. Captures are taken by `pup init` and `pup audit`, not at each
     merge (decision 38), so the table names every merge in the window rather than claiming one
     cause; a window with none says no pup merge fell between the two snapshots.
     *Rejected.* Capturing a baseline at each merge, so every move has exactly one session: it is
     a full measurement per merge, the audit's job. Session ids as text on the axis: they collide
     once merges are close, where a hover and the merge list below do not. Evenly spaced captures
     with merges between them by index: a week and a month between captures would look alike.
     *Hardening.* Like every sheet, Health is re-rendered on each poll a stream is open for; it
     reads one row per capture and one per merged session, and every series is reduced, not
     spread, so a long history cannot overflow the call stack.
     *Tests.* In `chart.test.ts`, the time chart has its title and figure line, places points by
     time, breaks at a gap and at `breakBefore`, dots a lone point, links a marker with an `href`,
     escapes a marker's label, draws a series measured nowhere as a frame, and draws no NaN for
     non-finite values or a non-finite marker time. In `web-dashboard-health.test.ts`, an empty
     store shows a hint per section and no SVG; three snapshots and two merges draw the expected
     points and markers, the PR'd merge a link and a re-gated session one merge; a gap and a rule
     change break the line; the moves table ranks a figure leaving zero above a 10% rise, compares
     across a gap, and names the sessions in each window; markup, C0/C1 controls and U+202E planted
     in session ids, PR urls and a capture time reach the page escaped or not at all. In
     `web-dashboard.test.ts`, the bar links all three sheets and the empty store renders Health's
     hint; in `baseline-history-repository.test.ts`, `captureDebt` reads a capture's debt and none
     when it is absent or does not parse.
