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
    diff it exists on is a known binary (`blobIsKnownBinary`, `src/core/git-diff.client.ts`).
    A side is one when four things hold. It is a blob of at most `BINARY_FREE_MAX_BYTES`
    (1 MiB). Its first 8000 bytes hold a NUL. Its bytes open with the magic number of a format
    in `BINARY_FORMATS`. And its path ends with an extension that same format is committed
    under, in any ASCII case. Every other file git reports as binary is recounted from its
    `--text` patch and named in `forged`. That flags it at any size, as decision 53 flags a
    text file git was told to call binary. A path whose extension no format names is
    recounted without reading a blob. Extension and magic are both required because the
    session writes both: a `.js` file opening with a PNG signature is recounted, and so is a
    `.png` whose bytes are code. A known binary replaced by text is recounted too. The old
    rule skipped a file when either side was binary. The diff-size detail now names these
    files as binary files that are no known format of at most 1 MiB. The ledger description
    keeps its `Text files git reports as binary` wording, so a re-gate still matches an
    entry filed before this decision.
    *Which magics.* Each magic in the table holds a byte that no source text can hold where
    it sits: a NUL, a control character, or a byte that cannot start UTF-8. That byte comes
    before any byte that could open a comment or a string, so no JavaScript, TypeScript or
    Python loader runs a file that opens with it. What is left: PNG, JPEG, ICO, TIFF,
    WebM/Matroska, MP3 frames and TrueType's `\0\x01\0\0`. Left out, because the magic is
    printable and the file can be written as `GIF89a=0//\0`: GIF, RIFF (WebP, WAV, AVI),
    BMP, PDF, WOFF, WOFF2, OTF, Ogg, FLAC, an MP3 `ID3` tag and TrueType's `true`. MP4 and
    its kin are left out because `ftyp` sits at offset 4 and leaves bytes 0 to 3 free for
    code. Archives (zip and its kin, gzip, xz, 7z), WebAssembly, Java classes and SQLite are
    left out because their content is files or code a loader unpacks.
    *Absence.* A side is absent only when `ls-tree` for the path on that revision lists
    nothing. The blob is then read by the oid `ls-tree` gave, through `readBlobs`. A git
    that fails, times out or is killed throws, and so does an object `ls-tree` lists with
    the size `BAD` because it cannot read it. Treating a failed `cat-file -e` as absence
    would have skipped the file uncounted, the open direction.
    *Not taken.* Flagging a known binary under a source or test path. A binary can never be
    a test, because the test split takes only the `.test.ts` suffix. And every path outside
    `docs/` counts as source (decision 110), so the rule would flag every image outside
    `docs/`. Reading "source path" as a directory such as `src/` or `lib/` is beaten by
    moving the file. Tightening the magics stops the loader instead, and the cap bounds how
    much a known format can carry wherever it sits.
    *Ceilings.* A repo committing a format outside the table, or a known one over 1 MiB,
    meets a forged flag to accept (decision 17). Its patch is then parsed as text, and a
    patch larger than `GIT_MAX_BUFFER` (64 MiB) errors the gate. That costs a repo
    committing GIFs, WebP, PDFs, web fonts or videos one acceptance per merge that adds one.
    A loader that runs a file past bytes no source can hold still runs a known binary under
    the cap: PHP's `include` prints a PNG's bytes and runs a `<?php` block inside it, and a
    shell running a file line by line goes on past the lines it cannot run. Up to 1 MiB of
    such content per file goes uncounted. Symlink blobs holding a NUL, which no checkout
    writes, are recounted and flagged. The recount still runs `merge-base` and one `diff`
    per `-\t-` file, so many NUL-carrying files still cost two processes each. Batching
    that means parsing one multi-file patch, and stays owed.
    *Hole 2: one git process per blob.* The decision 110 reach checks ran `cat-file blob`
    once per symlink in the branch tree and once per file `git grep -l` listed. A tree of
    20 000 tiny files held the merge lock for minutes.
    *The rule.* `readBranchTree` runs `ls-tree -r -l -z`, which gives every blob's oid and
    size. Every symlink's target, then each round's listed importers, is read through one
    `git cat-file --batch` (`readBlobs`). Importers are read by oid, not by `<rev>:<path>`,
    so `core.precomposeUnicode` has no path to rewrite (decision 114). A listed path the
    tree does not hold refuses, as an unprefixed listing entry does. The reach checks now
    run a fixed number of git processes plus two per reach round, however many files the
    tree holds. Grep does not take `-I`: it would skip a JavaScript importer whose NUL sits
    in a comment. A binary file grep lists is still read whole, inside the one batch.
    *The batch fails closed.* Each `cat-file blob` read used to be capped at
    `GIT_MAX_BUFFER` on its own. The batch holds every listed file at once, so the sizes it
    asks for may not add up past `GIT_MAX_BUFFER` together, or it throws before running git.
    The output buffer is sized exactly from those sizes. The batch runs under
    `GIT_READ_TIMEOUT_MS` (30 s), as does the `ls-tree` behind each known-binary check: a read
    stalled under the merge lock throws instead of holding the lock. Each answer must name
    the oid asked for, in order, as a blob of the listed size followed by its newline, and
    nothing may follow the last one. A missing object, a wrong size or a stray byte throws,
    so no caller reads a blob as empty. Past the cap, a branch whose test stems are named
    by more than 64 MiB of files errors the gate. One file over 64 MiB already did.
    *Tests.* In `git-diff-client.test.ts`, a `.ts` and a `.js` file opening with `// \0`
    recount all 5 001 lines. A PNG, a deleted PNG, a new PNG, an `.ICO` and a PNG of exactly
    1 MiB stay null, with or without `* -diff`. A PNG replaced by text, a `.png` holding text
    with a NUL, a `.js` opening with a PNG signature and a `.png` opening with `GIF89a` all
    recount. So do polyglots written as `GIF89a=0//\0` in a `.gif`, `true//\0` in a `.ttf`
    and `%PDF-//\0` in a `.pdf`, `x=1;ftyp//\0` in an `.mp4`, a `.zip`, a `.wasm`, and a
    PNG one byte over the cap. A known-format path whose blob object is deleted throws
    instead of returning null. `readBlobs` returns each blob byte for byte (a NUL, an empty
    blob, a repeat). It refuses a missing oid, a size one byte short (the buffer overflows)
    or long, and, before running git, sizes that add past 64 MiB. In `merge-gate.test.ts`, a
    5 000-line `.ts` with a NUL counts 5 001 source lines and is forged, beside a real PNG
    that counts nothing. An importer with a NUL in a comment still reaches its test. A tree
    with 40 links and 40 importers runs exactly as many git processes as a tree with 1 of
    each, with two `cat-file --batch` calls, each carrying the 30 s timeout, and no
    `cat-file blob`. The symlink-NUL case expects both NUL-carrying links forged. In
    `merge-gate-open-pr.test.ts`, the real binary that stays free under a forged
    `* -diff` is an `.ico`.
