# 0121. `pup ui` never draws a frame as tall as the terminal (2026-10-28).

- Status: accepted

121. **`pup ui` never draws a frame as tall as the terminal (2026-10-28).** Ink clears the
    terminal and rewrites the whole frame whenever the frame is taller than the terminal
    (`shouldClearTerminalForFrame`: it was overflowing, or is overflowing and had a previous
    frame), and only takes its incremental path under that line. `pup ui` re-reads every two
    seconds and the footer carries the read's timestamp, so a fleet with thirty planned tasks
    redrew and flickered the whole screen every two seconds.
    *Rule.* The frame is at most one row short of the terminal. `useTerminalSize` reads the
    height and width from Ink's stdout and re-reads them on `resize`, so a resize re-fits; a
    stream with no size (a pipe) reads as unbounded and nothing is clipped. `App` counts what
    cannot shrink (header, unreadable stores, the margins between blocks, prompt, footer, merge
    pane), and the rest is the body. The debt and radar blocks are each held to a quarter of the
    body (split evenly across projects, never under two lines each: a trailer for debt, the
    stale notice for radar), and the session and backlog rows share what is left as one window
    around the cursor. Every line counted as one row is truncated (`wrap="truncate-end"`, the
    input prompt `truncate-start` so its cursor stays in view), never wrapped, so a narrow
    terminal cannot add rows the count did not see. The y/n question is the one exception: `u`
    asks with the stored block reason, which nothing else on screen shows and which runs to two
    hundred characters, and an operator cannot answer a question whose cause or `(y/n)` was cut
    off. It is broken at spaces into rows of the terminal's width by `wrapLines`, each row drawn
    truncated, and `App` counts the rows that function returns rather than leaving the breaks to
    Ink's own wrap, which it could not see. A list that
    was cut ends in a `+N more` line that is counted in its budget. The window is a function
    of the cursor alone, so a refresh does not move it, and moving the cursor past its edge
    scrolls it. The detail pane still replaces the table.
    *Known limits.* The line counts are kept by hand beside the components, so a component
    that gains a line must be counted in `App`; the test that renders the app at several row
    counts is what catches the drift. The floors can exceed a terminal under about sixteen rows
    with several projects, and the detail pane and the merge log are not windowed.
    *Rejected.* Measuring the rendered frame with Ink's `measureElement` and clipping to it:
    it needs a render to learn the height, so the first frame would already overflow. Ink's
    own `<Static>`: it is append-only and cannot hold a table that updates in place.
