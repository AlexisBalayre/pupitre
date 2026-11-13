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
    A side is one when five things hold. It is a non-executable regular file (mode 100644,
    never 100755 or a 120000 symlink) of at most `BINARY_FREE_MAX_BYTES` (1 MiB). Its first 8000 bytes hold
    a NUL. Its bytes open with the magic number of a format
    in `BINARY_FORMATS`. Its path ends with an extension that same format is committed under,
    in any ASCII case, and only ASCII is folded: `toLowerCase` would read `.mKv` written with
    the Kelvin sign U+212A as `.mkv`. And no byte of it starts a zip end-of-central-directory
    signature (`PK\x05\x06`) or local file header (`PK\x03\x04`), no byte of it starts a
    PHP phar stub's end (`__HALT_COMPILER`, in any ASCII case), and its first 512 bytes are
    no tar header whose checksum holds. The skips one diff makes also share a budget of
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
    left out because their content is files or code a loader unpacks. PHP's `phar://`
    wrapper finds an archive by its stub's `__HALT_COMPILER();` after whatever bytes come
    first, and its entries may be compressed: a PNG holding one is a module
    `include 'phar://assets/x.png/a.php'` runs. So a blob holding that token anywhere, in
    any case as PHP reads it, is never a known binary either. PHP also opens a file as a
    tar phar, with no stub at all, when its first 512 bytes pass the tar header checksum:
    the octal number at offset 148 equals the sum of those bytes with the checksum's eight
    read as spaces. A PNG's signature and IHDR fit in a tar name field, and an ancillary
    chunk can fill the header to match, so the plain-text entry after it runs. A blob
    whose first 512 bytes pass that check, the number read after any spaces or NULs and
    the sum taken over unsigned bytes, as PHP and POSIX do, or signed, as GNU tar still
    accepts, is never a known binary. And a streaming zip reader walks the local file
    headers rather than the end record, so `PK\x03\x04` anywhere refuses too.
    *Sides come from the diff, by oid.* `gitDiffNumstat` runs `--raw --no-abbrev` beside
    `--numstat` in one `git diff`, which lists every raw record first, in the order of the
    numstat records, and gives each `-\t-` entry its `sides`: the base and branch mode and
    oid, a side absent only where `--raw` lists the all-zero mode, never on both sides. Raw
    and numstat records come from one diff queue, one for one; an entry without sides
    throws in the recount. A renamed entry carries the path it was
    `renamedFrom`, and its base side is that blob, judged by that path's extension: a
    source file renamed into a `.png` is then recounted, with both paths in the recount's
    pathspec, not skipped as an image with no base side. Numstat prints `-\t-` for a
    binary pair even when its content is unchanged, so a rename keeping the oid and mode
    reached the recount too: a moved PDF or PNG over the cap counted 0 lines and was
    forged, and moved small PNGs spent the budget. Some pairs add nothing to the tree:
    both sides exist, with one oid and one mode, and one extension. That extension is
    the basename from its last dot, as written, case included. It must be plain: a dot
    and one or more ASCII letters or digits, nothing else (`formatsNamed` reads it
    ASCII-folded, so it names the same formats too). Such a
    pair answers null unread and spends nothing, as numstat counts a text rename `0\t0`.
    The blob is the same, so its magic and its formats are too, and nothing needs
    reading. A mode change on the same oid is still recounted, because the new mode is
    what a 100755 PNG runs by. So is any other rename, since the same bytes can then be
    read as the new name. A PNG on `main` carrying a `<?php` block, renamed unchanged to
    `.php`, `.sh` or a name no format takes, recounts 0 lines and is forged. So is a
    NUL-carrying `.pdf` renamed to `.js`, as it may have reached `main` uncounted under
    the old NUL rule. A case change (`x.PHP` to `x.php`) recounts too, as a server
    mapping `.php` runs only the one. So do two names without an extension
    (`tools/payload` moved to `.husky/pre-commit`, a hook), and two ending in the dots and
    spaces Windows strips from a name: `a.` to `b.php.` and `a. ` to `b.php. `, both of
    which Windows opens as `b.php`, `a.. ` to `b.. `, and `x.png ` to `y.png `. A length
    check let `. ` through, two bytes matching on both sides, so the rule names the one
    shape that skips rather than the shapes that do not. Matching only known formats on both
    paths would have flagged a moved PDF again. A copy keeps its
    source, so one oid on both sides would add a file while spending nothing. Copies
    never pass as renames, because `gitDiffNumstat` pins `diff.renames=true` over a
    session-written `copies` and passes no `-C`. Each side's size comes from
    `cat-file -s` and its bytes from `readBlobs`, by oid. Paths were the key before: an
    `ls-tree` of the path on each revision, absent when it listed nothing. But `runGit`
    decodes git's output as UTF-8, so a name that is not UTF-8 reached `ls-tree` as U+FFFD,
    a name the tree did not hold. A target PNG renamed to such a name, with a payload
    appended, read as absent on the branch side and skipped unread, at any size; and a tiny
    PNG committed under the U+FFFD spelling answered the lookup for the hidden file. A git
    that fails, times out or is killed throws, and so does a blob `cat-file -s` cannot
    size. Treating a failed read as absence would skip the file uncounted, the open
    direction. The recount reads the same oids: the `-U0` hunks of `git diff <base oid>
    <branch oid>`, or, for a file only one side holds, that blob's lines, read through
    `readBlobs`. Read by its decoded path, a recounted file whose name is not UTF-8 counted
    the hunks of whatever that name matched, or none: a 5 000-line source file with a NUL
    counted 0 lines. An entry without sides throws, and so does one with neither side,
    which would otherwise match itself as one oid and skip.
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
    whatever their bytes. The recount still runs a `cat-file -s` per side and a `diff` or
    a blob read per `-\t-` file, so many NUL-carrying files still cost a few processes
    each. A real image whose first 512 bytes pass the tar checksum, which needs octal
    digits at offset 148 matching the sum, or which holds `PK\x03\x04`, is flagged. Batching
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
    `git cat-file --batch` (`readBlobs`, in `src/core/git-blobs.client.ts`, which spawns
    through `runGitBytes`, so git still runs from `git-diff.client.ts` alone, decision 73).
    Importers are read by oid, not by `<rev>:<path>`,
    so `core.precomposeUnicode` has no path to rewrite (decision 114). A listed path the
    tree does not hold, which git does not list, has no blob to read, so it is read as
    naming every target, as a name that is not UTF-8 is; an unprefixed listing entry
    refuses. The reach checks now
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
    nothing may follow the last one: the exactly sized buffer overflows on a stray byte. A
    missing object, a wrong size or a stray byte throws,
    so no caller reads a blob as empty. Past the cap, a branch whose test stems are named
    by more than 64 MiB of files errors the gate. One file over 64 MiB already did.
    *Tests.* In `git-diff-client.test.ts`, a `.ts` and a `.js` file opening with `// \0`
    recount all 5 001 lines. A PNG, a deleted PNG, a new PNG, an `.ICO` and a PNG of exactly
    1 MiB stay null, with or without `* -diff`. A PNG replaced by text, a `.png` holding text
    with a NUL, a `.js` opening with a PNG signature and a `.png` opening with `GIF89a` all
    recount. So do polyglots written as `GIF89a=0//\0` in a `.gif`, `true//\0` in a `.ttf`
    and `%PDF-//\0` in a `.pdf`, `x=1;ftyp//\0` in an `.mp4`, a `.zip`, a `.wasm`, and a
    PNG one byte over the cap. A known-format path whose blob object is deleted throws
    instead of returning null. A `:(top)foo` file and an NFD file beside a binary NFC
    sibling recount their own lines under `* -diff`. An executable (100755) PNG recounts:
    the PNG signature puts a CR and LF before its first NUL, so bash runs the lines after
    it, and no real image needs the exec bit. A `.ts` renamed into a `.png` holding its bytes recounts,
    with the rename source and both oids in its numstat entry, and a PNG renamed into a
    PNG skips. A PDF with a NUL, a PNG over the cap and a small PNG each moved unchanged
    answer null and leave the budget whole. A PNG made executable in place, PNGs renamed
    unchanged to `.php`, `.sh` and `.dat`, a `.pdf` renamed to `.js`, `x.PHP` renamed to
    `x.php`, `payload` renamed to `pre-commit`, and `a.`, `a. `, `a.. ` and `x.png `
    renamed to `b.php.`, `b.php. `, `b.. ` and `y.png ` each recount 0 lines. Under a session-written `diff.renames=copies`, a PNG copied from a changed one
    is listed as added, with no `renamedFrom`, and its skip spends its size. An entry with
    neither side throws. A target PNG renamed to a name that is not UTF-8 with a zip end record
    appended recounts its 6 added lines, and so does a PNG over the cap under such a name
    beside a decoy PNG committed under its U+FFFD spelling, which skips: 10 lines, its
    own. A `.ts` with a NUL under a name that is not UTF-8 recounts 5 001 lines. A PNG
    holding `__HALT_COMPILER` or `__halt_Compiler`, or `PK\x03\x04`, is no known binary,
    and neither is one whose first 512 bytes pass the tar checksum by unsigned or by signed
    sum; one whose checksum field is off by one stays known. A PNG with a zip end record appended recounts, and so does one whose
    record sits more than 64 KiB plus 22 bytes before its end. A symlink blob opening with
    the PNG signature and a NUL, a `.mKv` spelled with the Kelvin sign and a `.png` with the
    PNG signature and no NUL under `* -diff` all recount. Every call passes the budget, which
    has no default: a fresh 4 MiB per call would cap nothing. With a shared budget, a deleted PNG spends nothing, a
    PNG the budget covers is skipped and spends its size, and the next one is recounted.
    In `git-blobs-client.test.ts`, `readBlobs` returns each blob byte for byte (a NUL, an
    empty blob, a repeat). It refuses a missing oid, a size one byte short (the buffer
    overflows) or long, and, before running git, a size that is no byte count or sizes that
    add past 64 MiB. In `merge-gate.test.ts`, a
    5 000-line `.ts` with a NUL counts 5 001 source lines and is forged, beside a real PNG
    that counts nothing. A PDF and a PNG moved unchanged count nothing and are not
    forged. PNGs renamed unchanged to `.php`, `.sh` and `.dat` are forged, and so are
    NUL-carrying files moved from `tools/payload` to `.husky/pre-commit`, from `x.PHP`
    to `x.php`, and from `a.`, `a. `, `a.. ` and `x.png ` to `b.php.`, `b.php. `, `b.. `
    and `y.png `. A `.ts`
    renamed into a PNG is forged, and so is the hidden file
    beside a decoy under the U+FFFD spelling of its name, counting its own 6 lines. An importer with a NUL in a comment still reaches its test. A tree
    with 40 links and 40 importers runs exactly as many git processes as a tree with 1 of
    each, with two `cat-file --batch` calls, each carrying the 30 s timeout, and no
    `cat-file blob`. The symlink-NUL case expects both NUL-carrying links forged. Under a
    `core.worktree` naming the repo's parent and `diff.relative`, a link, an importer, a
    NUL-carrying file and a Docusaurus witness all still count, and a committed symlink
    under a test name counts as source, by its mode from `rawDiffEntries`. Five PNGs of exactly 1 MiB
    skip four and recount and flag the fifth. In
    `merge-gate-open-pr.test.ts`, the real binary that stays free under a forged
    `* -diff` is an `.ico`.
