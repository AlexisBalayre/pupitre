# 0154. A diff-size binary is a known format by extension and magic, and the reach checks read blobs in one batch (2026-11-08)

- Status: accepted
- Amends: [0053](0053-a-null-numstat-is-a-measurement-not-a.md)
- Amends: [0110](0110-the-diff-size-flag-counts-source-lines-only.md)

154. **A diff-size binary is a known format by extension and magic, and the reach checks read
    blobs in one batch (2026-11-08).** Amends decisions 53 and 110. The t-mvphibsy security
    review found two holes in the diff-size count.
    *Hole 1: a NUL hid a source file.* Decision 53 recounted a file that `--numstat`
    reported as `-\t-` unless git's content rule called it binary: a NUL in its first 8000
    bytes. One NUL in a comment, such as `// \0` in a `.ts` file, meets that rule. A
    5 000-line source file then counted as 0 lines and was not flagged.
    *The rule.* `gitDiffBinaryRecount` skips a file only when every side of the merge-base
    diff it exists on is a known binary. A side is one when its first 8000 bytes hold a NUL,
    its bytes open with the magic number of a format in `BINARY_FORMATS`
    (`src/core/git-diff.client.ts`), and its path ends with an extension that same format
    is committed under, in any ASCII case. The table covers common images, audio and video,
    fonts, PDF, zip-based and compressed archives, WebAssembly, Java classes and SQLite.
    Every other file git reports as binary is recounted from its `--text` patch and named in
    `forged`. That flags it at any size, as decision 53 flags a text file git was told to
    call binary. A path whose extension no format names is recounted without reading a blob.
    Both checks are required because the session writes both. A `.js` file that opens with a
    PNG signature is recounted, and so is a `.png` whose bytes are code. A known binary
    replaced by text is recounted too. The old rule skipped a file when either side was
    binary.
    *Not taken.* Flagging only a binary under a source extension. Most of the split counts as
    source (decision 110), so "source path" would mean every path but tests and docs.
    Reading it as "a code extension" would leave code committed as `x.png`, which a CommonJS
    `require` runs, uncounted.
    *Ceilings.* A repo committing a binary format outside the table meets a forged flag to
    accept (decision 17), and its patch is parsed as text. A recounted binary's patch larger
    than `GIT_MAX_BUFFER` (64 MiB) errors the gate. A polyglot can still pass as a known
    binary: a file whose format's magic is printable (`GIF89a`, `ID3`, `wOFF`), named with
    that format's extension, and loaded as code by a loader that ignores extensions. Its
    lines go uncounted. Symlink blobs holding a NUL, which no checkout writes, are now
    recounted and flagged. The recount still runs `merge-base` and one `diff` per
    `-\t-` file, so many NUL-carrying files still cost two processes each. Batching that
    means parsing one multi-file patch, and stays owed.
    *Hole 2: one git process per blob.* The decision 110 reach checks ran `cat-file blob`
    once per symlink in the branch tree and once per file `git grep -l` listed. A tree of
    20 000 tiny files held the merge lock for minutes.
    *The rule.* `readBranchTree` runs `ls-tree -r -l -z`, which gives every blob's oid and
    size. Every symlink's target, then each round's listed importers, is read through one
    `git cat-file --batch` (`readBlobs`). Its output buffer is sized exactly from those
    sizes, and an oid git does not hold refuses. Importers are read by oid, not by
    `<rev>:<path>`, so `core.precomposeUnicode` has no path to rewrite (decision 114). A
    listed path the tree does not hold refuses, as an unprefixed listing entry does. The
    reach checks now run a fixed number of git processes plus two per reach round, however
    many files the tree holds. Grep does not take `-I`: it would skip a JavaScript importer
    whose NUL sits in a comment. A binary file grep lists is still read whole, now inside
    the one batch, and every listed file's content is held in memory at once.
    *Tests.* In `git-diff-client.test.ts`, a `.ts` and a `.js` file opening with `// \0`
    recount all 5 001 lines. A PNG, a deleted PNG, a new PNG and a `.WOFF2` stay null, with
    or without `* -diff`. A PNG replaced by text, a `.png` holding text with a NUL, a `.js`
    opening with a PNG signature and a `.png` opening with `GIF89a` all recount. `readBlobs`
    returns each blob byte for byte (a NUL, an empty blob, a repeat) and refuses a missing
    oid. In `merge-gate.test.ts`, a 5 000-line `.ts` with a NUL counts 5 001 source lines and
    is forged, beside a real PNG that counts nothing. An importer with a NUL in a comment
    still reaches its test. A tree with 40 links and 40 importers runs exactly as many git
    processes as a tree with 1 of each, with two `cat-file --batch` calls and no
    `cat-file blob`. The symlink-NUL case now expects both NUL-carrying links forged.
