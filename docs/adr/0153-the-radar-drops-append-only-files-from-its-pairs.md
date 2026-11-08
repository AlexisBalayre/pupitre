# 0153. The conflict radar drops append-only files from its pairs and names them in one line (2026-11-08)

- Status: accepted
- Amends: [0104](0104-peer-joined-introductions-and-main-landed-notices-go.md)

153. **The conflict radar drops append-only files from its pairs and names them in one line
    (2026-11-08).**
    Amends decision 104, which left `docs/adr/` out of peer introductions only. Every session that
    records a decision appends a line to the index in `docs/adr/README.md` (decision 109), so with
    six live sessions `pup watch`, `pup ui` and `pup status` printed about 15 `OVERLAP` lines that
    named nothing else, and a real shared file such as `src/cli/index.test.ts` showed as `(+1 more)`
    behind them.
    `radarView` in `overlap.service.ts` applies `filesWorthANotice` to each pair: the files under
    `docs/adr/` are dropped from it, and a pair left with no file is dropped whole. The renderers
    print one line per dropped file instead, `docs/adr/README.md: N sessions append (decision 109)`,
    where N counts the distinct sessions in a dropped pair. `pup watch` also treats a sweep with
    only such a line as not clear. The risk score of `pup review` counts a peer as an overlap only
    on a file other than these, since its weight read the same noise.
    *The record is unchanged.* The `overlaps` table and the snapshot's `overlaps` keep the pairs in
    full, and the view is taken where they are printed. So the merge gate, whose fresh-base stage
    meets the conflict, and the main-landed notice, which keeps the files (decision 104), still see
    the overlap.
    *Ceiling.* `pup ui` sizes its radar block from the stored pair count, so it still reserves the
    rows the dropped pairs would have taken and leaves some of them blank. The count is in
    `app.component.tsx`, outside this change.
    *Tests.* `overlap.test.ts` pins `radarView`: the index is dropped from a pair that also names a
    source file, a pair left empty is dropped whole and each session is counted once, and
    `docs/adrift.md` is kept. `index.test.ts` runs `pup watch --once` over two sessions sharing the
    index and a test file, and over two sharing only the index.
