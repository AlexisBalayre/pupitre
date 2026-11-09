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
    diff it exists on is a known binary (`blobIsKnownBinary` in `src/core/git-diff.client.ts`,
    which reads the entry and leaves the decision to `src/core/known-binary.utils.ts`).
    A side is one when five things hold. It is a regular file (mode 100644 or 100755, never
    a 120000 symlink) of at most `BINARY_FREE_MAX_BYTES` (1 MiB). Its first 8000 bytes hold
    a NUL. Its bytes open with the magic number of a format
    in `BINARY_FORMATS`. Its path ends with an extension that same format is committed under,
    in any ASCII case, and only ASCII is folded: `toLowerCase` would read `.mKv` written with
    the Kelvin sign U+212A as `.mkv`. And no byte of it starts a zip end-of-central-directory
    signature (`PK\x05\x06`). The skips one diff makes also share a budget of
    `BINARY_FREE_TOTAL_MAX_BYTES` (4 MiB), spent in path order with the bytes each file's
    branch side holds; a file the branch deleted spends nothing. The file that would go past
    the budget is recounted and flagged, not skipped. Every other file git reports as binary is recounted from its
    `--text` patch and named in `forged`. That flags it at any size, as decision 53 flags a
    text file git was told to call binary. A path whose extension no format names is
    recounted without reading a blob. Extension and magic are both required because the
    session writes both: a `.js` file opening with a PNG signature is recounted, and so is a
    `.png` whose bytes are code. A known binary replaced by text is recounted too. The old
    rule skipped a file when either side was binary. The diff-size detail now names these
    files as binary files that are no known format within 1 MiB a file and 4 MiB a diff. The ledger description
    keeps its `Text files git reports as binary` wording, so a re-gate still matches an
    entry filed before this decision.
    *Which magics.* Each magic in the table holds a NUL, a control character or a non-ASCII
    byte before any byte that could open a comment or a string. That keeps a loader reading
    UTF-8 from a file's first byte from running it, but it does not make the bytes something
    no source text can hold: decoded as Latin-1, a JPEG opens with `ÿØÿ`, a valid JavaScript
    identifier. What bounds the risk is the caps, 1 MiB a file and 4 MiB a diff, not the
    magic. A zip reader starts from the other end: Python's `zipimport` and `runpy` and
    `java -jar` find a zip by its end record, whatever the extension or first bytes. A PNG
    with a zip appended is then a module path that one counted line imports
    (`sys.path.insert(0, 'assets/x.png')`), with megabytes of source compressed inside. How
    far back a reader searches varies: the classic reach is 64 KiB plus 22 bytes, and a
    Zip64-aware `zipimport` (Python 3.13 on) goes further. So the whole blob, already capped
    at 1 MiB and in memory, is searched, and one holding that record anywhere is never a
    known binary. What is left: PNG, JPEG, ICO, TIFF,
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
    moving the file. Tightening the magics and refusing a zip end record stop most loaders instead.
    The 1 MiB file cap and the 4 MiB diff budget then bound how much known formats can carry
    together, wherever they sit.
    *Ceilings.* A repo committing a format outside the table, a known one over 1 MiB, or
    known binaries adding more than 4 MiB in one diff meets a forged flag to accept
    (decision 17). Which file goes past the budget follows path order, not size. Its patch is then parsed as text, and a
    patch larger than `GIT_MAX_BUFFER` (64 MiB) errors the gate. That costs a repo
    committing GIFs, WebP, PDFs, web fonts or videos one acceptance per merge that adds one.
    A loader that runs a file past bytes it cannot run still runs a known binary under
    the cap: PHP's `include` prints a PNG's bytes and runs a `<?php` block inside it, and a
    shell running a file line by line goes on past the lines it cannot run. Up to 1 MiB of
    such content per file, and 4 MiB per diff, goes uncounted, and so does a loader that
    decodes the magic as text it accepts, such as Latin-1. A real image whose compressed data
    happens to hold `PK\x05\x06` is flagged, about one 1 MiB file in 4 096. Symlink blobs,
    which hold a NUL only when no checkout wrote them, are recounted and flagged by mode,
    whatever their bytes. The recount still runs `merge-base` and one `diff`
    per `-\t-` file, so many NUL-carrying files still cost two processes each. Batching
    that means parsing one multi-file patch, and stays owed.
    *Reads from the top of the tree.* The merge gate does not call `assertNoWorktreeConfig`,
    and a session can write `core.worktree` into the shared config. One naming a directory
    above the repo puts every git child under a `<repo>/` prefix (verified on Git 2.54).
    Then `ls-tree`, `git grep` and a pathspec'd `git diff` scoped to it find nothing: links go
    unseen, importers unlisted and a recount reads no hunks. A `diff.relative` beside it
    empties the numstat too. So every diff-size read names the top. `ls-tree` takes
    `--full-tree`. The importer grep takes `--full-name` and the pathspec `:(top)`, and the
    Docusaurus grep `:(top,glob,icase)`. The per-file diff behind the recount and patch
    coverage takes `:(top,literal)<path>` in place of `--literal-pathspecs`. And every diff
    takes `--no-relative`, through `DIFF_SAFE_FLAGS` and in `rawDiffEntries`. The gate's
    other git reads are not audited here for the prefix; refusing `core.worktree` at the
    gate would close it for all of them, and stays owed.
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
    blob, a repeat). A PNG with a zip end record appended recounts, and so does one whose
    record sits more than 64 KiB plus 22 bytes before its end. A symlink blob opening with
    the PNG signature and a NUL, a `.mKv` spelled with the Kelvin sign and a `.png` with the
    PNG signature and no NUL under `* -diff` all recount. Every call passes the budget, which
    has no default: a fresh 4 MiB per call would cap nothing. With a shared budget, a deleted PNG spends nothing, a
    PNG the budget covers is skipped and spends its size, and the next one is recounted.
    `readBlobs` refuses a missing oid, a size one byte short (the buffer overflows)
    or long, and, before running git, sizes that add past 64 MiB. In `merge-gate.test.ts`, a
    5 000-line `.ts` with a NUL counts 5 001 source lines and is forged, beside a real PNG
    that counts nothing. An importer with a NUL in a comment still reaches its test. A tree
    with 40 links and 40 importers runs exactly as many git processes as a tree with 1 of
    each, with two `cat-file --batch` calls, each carrying the 30 s timeout, and no
    `cat-file blob`. The symlink-NUL case expects both NUL-carrying links forged. Under a
    `core.worktree` naming the repo's parent and `diff.relative`, a link, an importer, a
    NUL-carrying file and a Docusaurus witness all still count. Five PNGs of exactly 1 MiB
    skip four and recount and flag the fifth. In
    `merge-gate-open-pr.test.ts`, the real binary that stays free under a forged
    `* -diff` is an `.ico`.
