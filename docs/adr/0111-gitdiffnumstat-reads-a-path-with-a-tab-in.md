# 0111. `gitDiffNumstat` reads a path with a tab in it whole (2026-10-27).

- Status: accepted

111. **`gitDiffNumstat` reads a path with a tab in it whole (2026-10-27).** It took a `-z`
    numstat entry's path as the third tab-separated field and dropped the rest, so a path was
    cut at its first tab. `-z` never quotes a path, so a tab in one reaches the entry as is:
    a file under a directory named `src/a.test.ts<TAB>z` was counted as
    `src/a.test.ts`, a test, and one under a root directory named `pnpm-lock.yaml<TAB>x` as
    the root lockfile, which the diff-size stage leaves out of its count. A path that starts
    with a tab, such as `<TAB>lead.ts` at the root, left the third field empty, so the entry
    was taken for a rename: the two records after it were swallowed as its old and new paths,
    and the parse ran on out of step (the security review's repro lost two binary entries and
    counted `-<TAB>-<TAB>bin<TAB>tab.bin` as a one-line path). Everything after the second
    tab is now the path, empty only for a rename. A renamed entry, whose old and new paths
    come as NUL fields of their own, is read as before. This closes the tab-in-path item the diff-size
    decision (110, t-mvphibsy's branch) lists as owed. The review queue's per-file counts read
    the same numstat and now name such a file whole too.
    *Tests.* In `git-diff-client.test.ts`, `src/a.test.ts<TAB>z/impl.ts` is listed under its
    full path beside a plain file, and `pnpm-lock.yaml<TAB>x/big.ts` is listed whole and
    matches no `LOCKFILE_NAMES` entry, and `<TAB>lead.ts` is listed whole with the two
    binaries and the text file after it. All three fail with the path cut at its first tab.
