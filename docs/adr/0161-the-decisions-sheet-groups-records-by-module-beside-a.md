# 0161. The Decisions sheet groups the decision records by module beside a treemap of `src/` shaded by debt or recent merges (2026-11-09)

- Status: accepted
- Amends: [0098](0098-pup-dashboard-is-a-set-of-sheets-figures.md)

161. **The Decisions sheet groups the decision records by module beside a treemap of `src/`
     shaded by debt or recent merges (2026-11-09).**
     Amends decision 98, which left Decisions to its own task. The bar now reads Overview, Health,
     Debt, Decisions, and `?sheet=decisions` is served under everything decision 98 kept from
     decision 91: the token and Host guard, GET only, the CSP, nothing loaded from elsewhere.
     *Timeline.* Every decision record, newest first as `pup log` lists them, grouped by module.
     A record touches many files and is shown once, under its module: the directory most of its
     files sit in, which is the module `pup map` names. A tie goes to the first directory by path,
     and a record naming no file goes under "(no file named)". Modules are ordered by their newest
     record. A row bar chart counts the records of the ten modules holding the most. Each record
     shows its id, its session (`UNMINTED_LABEL` outside the minted shape), its time in UTC, its
     summary, its alternatives and its files. The prose is scrubbed line by line as `pup log`
     prints it (`sanitizeReason`, then `displayText`, then `escapeHtml`), so a multi-line summary
     keeps its lines.
     *Module map.* A treemap of the checkout's `src/`, each file sized by its line count and each
     module outlined over its files. A file is shaded by its open ledger entries or, through a
     toggle, by the sessions whose merge touched it in the last 30 days. The shade buckets are
     none, one, two or three, and four or more. A session counts once per file however many merges
     its fix rounds recorded (decision 98). The toggle is two radio inputs ahead of the figure,
     with `CHART_CSS` sibling rules. It switches with the script off and needs no style attribute.
     A board the stream swaps in resets it to debt. The squarified layout (`squarify`) gives each
     cell an area in proportion to its value, and the cells fill the plot, so the areas sum to the
     total line count. A module's name is drawn over its cells rather than above them, so no cell
     gives up area to a heading. Every cell has its own `<title>`. The figure line gives the total
     and, for each module, its lines, its file count, and how many of its files each shade marks.
     *Reading the checkout.* The map reads files on disk, not the store, so it is bounded like
     decision 98's reads. The walk starts at `<root>/src`, in path order, and follows no link. A
     linked `src/` maps nothing, and a linked file or directory under it is skipped, so nothing
     outside the project root is read. `node_modules` and `.worktrees` are skipped. A file is opened
     with `O_NOFOLLOW | O_NONBLOCK` and checked on its descriptor, so a FIFO or a device is never
     blocked on, and only the size it had when opened is read. A file over 1 MiB is left unread,
     and the sheet says how many were. The walk stops at 5,000 files or 64 MiB of them, counted by
     size, so where it stops does not depend on what an earlier poll read. Opening a file costs a
     hundred times its `lstat` (64 ms against 0.4 ms for this repo's 237 files). So each poll keeps
     the counts it read, keyed by path and stamped with the inode, size, mtime and ctime, and reads
     again only a file whose stamp moved. A warm poll of this repo takes 12 ms.
     *Rejected.* Grouping a record under every directory its files touch: one wide merge would fill
     every module's timeline. Grouping by the path's first segment: in this repo nearly every
     record lands under `src`. Line counts from `git ls-files` and blobs: a spawn every poll, and
     the map is of the checkout as it stands. A heading strip per module: the areas would no longer
     sum to the line count.
     *Tests.* In `chart.test.ts`, `squarify` gives each item an area equal to its value inside the
     box, and a zero, negative or non-finite value no area. The treemap's cell areas sum to the
     plot, each its share. The treemap has its title and figure line, a hover per cell, shades
     through classes and no inline colour, escaped labels and no NaN. In
     `web-dashboard-decisions.test.ts`, a record goes under its top directory with ties by path. A
     module lists its records newest first with their alternatives. The walk skips links in and
     out, `node_modules`, `.worktrees`, a FIFO and files outside `src/`, and maps nothing when
     `src/` is a link. A changed file is read again, and one over 1 MiB is unread and said. Debt
     counts open entries only, and merges count each session once within 30 days. The rendered
     cell areas sum to the total line count. Markup, C0/C1 controls and U+202E planted in a
     summary, alternatives, a file path, a session id and a file name on disk reach the page
     escaped or replaced. An empty store with no `src/` shows the two hints and no SVG. In
     `web-dashboard.test.ts`, the bar links the Decisions sheet with the token, and its empty
     store renders hints.
