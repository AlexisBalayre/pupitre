# 0114. The gate's per-file git reads pin `core.precomposeUnicode` off (2026-10-27).

- Status: accepted

114. **The gate's per-file git reads pin `core.precomposeUnicode` off (2026-10-27).**
    On macOS, `core.precomposeUnicode=true` makes git rewrite an NFD path argument to NFC
    before using it. `git init` there turns the key on, and a session can set it in the
    shared `$GIT_COMMON_DIR/config` (decision 50). A tree can hold both spellings of a name
    as two files, because the index takes any bytes; only a working tree on APFS cannot. Given `é.ts` spelled NFD, the per-file
    reads then answered for its NFC sibling (reproduced on git 2.39).
    *The hunks.* `diffHunks` passes the path after `--literal-pathspecs`, and the flag
    turns off magic, not the rewrite. An NFD file adding three lines read the NFC sibling's
    one-line hunk, so `gitDiffAddedLines` and the decision-53 recount saw the wrong lines.
    *The blob.* Decision 113 called `blobIsBinary`'s `<rev>:<path>` safe because it is an
    object name, not a pathspec, but the rewrite reaches object names too: `cat-file`
    returned the NFC sibling's blob. A binary sibling made the recount return null, which
    lets a text file the attributes call binary count as zero lines.
    *The pin.* `diffHunks` and both `cat-file` calls in `blobIsBinary` run with
    `-c core.precomposeUnicode=false` (`PATH_AS_GIVEN`), so git uses the path's bytes, which
    are the bytes `gitDiffPaths` and `--numstat` read from the tree. The pin is on these
    calls rather than in `GIT_SAFE_CONFIG`: that list reaches every git pup runs, and with
    the key off, a file created on disk with an NFD name, which the key had committed as
    NFC, shows in `status` as untracked. The reads that list paths take them from the tree,
    which the key does not touch. On other systems git ignores the key.
    *Tests.* In `git-diff-client.test.ts`, a branch adds an NFD `é.ts` of three lines and
    an NFC `é.ts` of one through the index, then turns the key on. `gitDiffAddedLines` gives
    each file its own lines, and with a binary NFC sibling `gitDiffBinaryRecount` still
    counts the NFD file's three lines. On macOS, each test fails with its pin removed.
