# 0098. `pup dashboard` is a set of sheets, figures and charts first, starting with Overview and Debt (2026-10-17)

- Status: accepted
- Amends: [0091](0091-pup-dashboard-serves-a-read-only-live-page.md)

98. **`pup dashboard` is a set of sheets, figures and charts first, starting with Overview and
    Debt (2026-10-17).**
    Amends decision 91. One long page of live sections tells the operator what runs, not what the
    project is becoming, and the operator wants the dashboard to be where the project is understood
    and debt is decided from what can be seen, not read. So the page becomes sheets: a bar of plain
    links across the top (Overview, Debt; Health, Tasks and Decisions follow as their own tasks),
    each sheet a short server-rendered page that leads with figures and inline-SVG charts, says a
    few lines, and links to its details. A sheet is named by `?sheet=`, Overview when the url names
    none, and an unknown name is a 404; every link carries the run token, since every request must.
    Each sheet has its own event stream (`/events?sheet=`), and the poll re-renders only the sheets
    a stream is open on, comparing each with its own last board. Everything else in decision 91
    stands: the same token and Host guard, GET only, the same CSP, nothing loaded from anywhere,
    every store string through `sanitizeReason` and then `escapeHtml`.
    *Charts.* `chart.utils.ts` draws a bar chart (columns for a series in time, rows for a ranking
    whose labels are long paths, a long label keeping its tail), a line chart and a sparkline, as
    inline SVG strings with no dependency. Each carries an SVG `<title>` and a figure line under it
    with every value in words, so the numbers read without the chart, and every bar its own
    `<title>` as its hover. The marks take their colour from the page's theme tokens through
    classes (`CHART_CSS`): the CSP admits no `style` attribute and a presentation attribute does
    not resolve `var()`, so light and dark follow `prefers-color-scheme` like the rest of the page.
    One sequential hue for every mark, since each chart draws one series. A chart with nothing to
    draw is not drawn: its section says so in one line.
    *Overview.* The brief's Destination as the goal (`briefDestination`, read through `readBrief`
    like every reader of the brief); four figure tiles; tasks done, in flight and planned; merges
    per week over eight weeks; then the live sections decision 91 listed, in its order, less the
    ledger, which moved to the Debt sheet. The tiles are open debt as `pup debt` counts it, and
    coverage, unused exports and duplicated lines off the snapshot's baseline, the figures `pup
    audit` stores and `pup status` prints, each capture read through one `debtFigures`. Each says
    how it moved against the newest `baseline_history` capture at least seven days old
    (`baselineHistoryAsOf`), coverage in percentage points; a duplication count stamped with
    another rule is not compared, as `pup audit` does not compare it (decision 39), and a sparkline
    draws the last eight captures. The ledger records no closing time, so open debt cannot say how
    it moved; its tile says how many entries were filed in the week (`countLedgerEntriesSince`),
    closed ones included. A task is done once a session of its merged, in flight while one is live,
    planned while nothing claims it. A session counts as a merge in the week of its first `merge`
    event, since a fix round's re-gate records another. The weeks end with today in UTC, so the
    buckets move once a day and an unchanged store still renders the same board between polls.
    *Debt.* The open ledger by kind (oversize diff, complexity rise, duplicated lines, other, told
    by how the gate's flag descriptions begin) and by age (under a week, one to four weeks, one to
    three months, older); the ten files carrying the most open entries; and a pay-down list of the
    five heaviest files. A file weighs the sum of its open entries, each counting 1 when fresh and
    one more every 30 days held, so old debt rises above the same count of new; ties go to more
    entries, then to the path. Each entry under it shows its description, reason, review-by,
    accepted-by and age, overdue marked by `listOverdueLedgerEntries`'s rule; an entry naming no
    file is ranked under "(no file named)" rather than left off. The whole ledger follows, folded,
    oldest first. A `files` column that does not parse names no file.
    *Rejected.* A client-side chart library: a dependency and a script source the CSP would have to
    admit. Charts drawn in the browser from JSON: the board would no longer be one server render
    that the page and the stream share. Tabs switched by script: a sheet as its own page keeps the
    page working with the script off and each stream reading only what its sheet shows.
    *Tests.* In `chart.test.ts`, every chart has its title and a figure line with every value, bars
    scale to the largest and a zero draws no mark, values print through the given format, no
    colour is inline, labels and titles are escaped, and a one-point line has no NaN. In
    `web-dashboard-debt.test.ts`, the ranking orders files by age-weighted entries with the oldest
    entry first in each, breaks ties by count then path, and keeps a fileless entry; read off a
    store, ages are whole days, overdue follows the ledger rule, closed entries are left out and
    unparseable files name none; the sheet counts kinds, ages and top files, ranks an old single
    entry above two new ones, and on an empty ledger shows its hint and no chart. In
    `web-dashboard.test.ts`, both sheets are served under a bar linking each with the token, the
    current one marked; an unknown sheet is a 404 and a sheet without the token a 403; an empty
    store renders hints and no SVG on both; the Overview leads with the Destination and not the
    Priorities; its tiles match `formatDebtTransition`'s figures and `pup debt`'s count with the
    right week's change; tasks and merges per week count as above; markup and C0/C1 control
    characters planted in a goal, a brief, a ledger description, reason, accepter and file path
    reach neither sheet unescaped; and the Debt sheet's stream sends its own board, then a new
    entry within one poll. The repositories' new queries have their own tests.
    *Hardening.* A sheet is re-rendered on every poll, synchronously, so what it reads must stay
    cheap and bounded. The brief's heading match is linear: the title runs from its first
    non-blank character, and the closing run and trailing blanks are cut with string operations,
    since the one-regex form backtracked cubically on a line of blanks ending in U+2028 (minutes
    at the brief's cap, the whole server frozen). `readBrief` reads through `readPlainFile`, which
    opens without blocking and checks the descriptor it reads, so a FIFO, a device or a huge file
    swapped in at the path is refused, not blocked on or read to the end, by the dashboard, a
    launch and a conductor start alike. Its cap is the 1 MiB every plain file shares, and the
    8,000 characters a brief may carry still refuse a longer one. A figure
    stored as a non-finite number (`1e999` parses to Infinity) is unmeasured in `debtFigures`, and
    the charts draw a non-finite value as no mark and halve the span so two finite extremes
    cannot overflow it, and an empty series draws an empty frame. Every ledger field on both
    sheets, the Overview's session and PR rows included, and the Destination also go through
    `displayText`, so a U+202E cannot make a path read as another. A sheet is published on its
    own: a stream that opens renders only its sheet, and the poll catches a sheet that cannot be
    rendered without skipping the others, so a ledger row the Debt sheet cannot read never ends
    or starves an Overview stream. Each poll reads the newest eight captures
    (`listRecentBaselineHistory`) and the sessions' first merges in the window in one grouped
    query. Tests: the planted heading line renders within a second, a FIFO brief and one linked
    to `/dev/zero` show the refusal, a U+202E in a description filed against a live session and
    in every other field reaches neither sheet, an Overview stream opens and updates while the
    Debt sheet cannot render, a baseline of `1e999` shows as unmeasured with no
    NaN, every chart draws no NaN for infinite values or ±1e308, and the bounded history lists
    the newest captures oldest first.
