import { basename } from 'node:path';

/**
 * Git's own content rule for a binary file: a NUL in the first 8000 bytes
 * (`buffer_is_binary`). Everything else git calls binary, it was told to.
 */
const BINARY_SNIFF_BYTES = 8000;

/** A format a diff-size count may skip: the extensions it is committed under, the bytes it opens with. */
export type BinaryFormat = { extensions: string[]; magic: string[] };

/**
 * The binary formats a diff-size count may skip (decision 154): the
 * extensions each is committed under and the bytes it opens with. A NUL is
 * not enough, as one in a source file's comment makes git call it binary.
 * Every magic holds a NUL, a control or a non-ASCII byte before any byte
 * that could open a comment or a string, which keeps a loader reading UTF-8
 * from its first byte from running the file. That does not hold for every
 * loader: decoded as Latin-1, a JPEG opens with `ÿØÿ`, a valid JavaScript
 * identifier. So the caps (`BINARY_FREE_MAX_BYTES`,
 * `BINARY_FREE_TOTAL_MAX_BYTES`) bound what a known binary can carry
 * uncounted. Formats whose magic is printable (GIF, RIFF, BMP, PDF, WOFF,
 * Ogg, FLAC, an MP3 `ID3` tag, a TrueType `true`) or sits past free leading
 * bytes (MP4's `ftyp`) are left out, as are archives and compiled code, whose
 * content is files or code a loader unpacks. A file outside this table is
 * recounted from its patch and flagged, which a repo committing another
 * format meets as a flag to accept.
 */
const BINARY_FORMATS: BinaryFormat[] = [
  { extensions: ['.png', '.apng'], magic: ['\x89PNG\r\n\x1a\n'] },
  { extensions: ['.jpg', '.jpeg'], magic: ['\xff\xd8\xff'] },
  { extensions: ['.ico'], magic: ['\0\0\x01\0'] },
  { extensions: ['.tif', '.tiff'], magic: ['II*\0', 'MM\0*'] },
  { extensions: ['.webm', '.mkv'], magic: ['\x1a\x45\xdf\xa3'] },
  { extensions: ['.mp3'], magic: ['\xff\xfb', '\xff\xf3', '\xff\xf2'] },
  { extensions: ['.ttf'], magic: ['\0\x01\0\0'] },
];

/**
 * The largest known binary a diff-size count may skip (decision 154). One
 * above it, on either side of the diff, is recounted and flagged: what a
 * known format holds past its magic is unread, and the cap bounds how much
 * of it goes uncounted.
 */
export const BINARY_FREE_MAX_BYTES = 1024 * 1024;

/**
 * The most bytes the known binaries one diff adds may skip together (decision
 * 154): past it, the file that would go over is recounted and flagged, so
 * many files under `BINARY_FREE_MAX_BYTES` cannot add up to an unread tree.
 */
export const BINARY_FREE_TOTAL_MAX_BYTES = 4 * 1024 * 1024;

/** The tree modes of a regular file; a 120000 symlink is no image a checkout writes. */
const REGULAR_FILE_MODES = ['100644', '100755'];

/**
 * A zip's end-of-central-directory signature. Python's `zipimport` and
 * `runpy` and `java -jar` find a zip by this record whatever the file's
 * extension or first bytes, so a PNG with a zip appended is a module path one
 * counted line can import. How far back a reader searches for it varies (a
 * Zip64-aware `zipimport` goes past the classic 64 KiB plus 22 bytes), so the
 * whole blob, already capped and read, is searched (decision 154).
 */
const ZIP_EOCD = Buffer.from('PK\x05\x06', 'latin1');

/**
 * The token that ends a PHP phar's stub, which PHP reads in any case. The
 * `phar://` wrapper finds an archive by it after whatever bytes come first,
 * and its entries may be compressed, so a PNG holding it is a module
 * `include 'phar://assets/x.png/a.php'` runs, its code unread (decision 154).
 */
const PHAR_STUB_END = '__halt_compiler';

/**
 * The formats `path`'s extension names, in any ASCII case. Only ASCII is
 * folded: `toLowerCase` folds the Kelvin sign U+212A to `k`, and `.mKv`
 * written with it names no format a reader opens as one.
 */
export function formatsNamed(path: string): BinaryFormat[] {
  const name = basename(path).replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return BINARY_FORMATS.filter((format) =>
    format.extensions.some((extension) => name.endsWith(extension)),
  );
}

/**
 * Whether a tree entry may be read as a known binary: a regular file not over
 * `BINARY_FREE_MAX_BYTES`. A size that is no number (`ls-tree` lists `BAD`
 * for an object it cannot read) is not over the cap, so the read goes ahead
 * and `readBlobs` refuses it, rather than this answer hiding the failure.
 */
export function mayBeKnownBinary(mode: string, size: number): boolean {
  return REGULAR_FILE_MODES.includes(mode) && !(size > BINARY_FREE_MAX_BYTES);
}

/** Git's content rule: a NUL in the first `BINARY_SNIFF_BYTES`. */
function holdsNul(blob: Buffer): boolean {
  return blob.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/** Whether `blob` holds a zip end record anywhere (`ZIP_EOCD`). */
function holdsZipEndRecord(blob: Buffer): boolean {
  return blob.includes(ZIP_EOCD);
}

/** Whether `blob` holds a phar stub's end (`PHAR_STUB_END`), in any ASCII case. */
function holdsPharStub(blob: Buffer): boolean {
  return blob.toString('latin1').toLowerCase().includes(PHAR_STUB_END);
}

/** Whether `blob` opens with the magic of one of `formats`. */
function opensWithMagic(blob: Buffer, formats: BinaryFormat[]): boolean {
  return formats.some(({ magic }) =>
    magic.some((bytes) => blob.subarray(0, bytes.length).equals(Buffer.from(bytes, 'latin1'))),
  );
}

/**
 * The size of `blob` when it is a known binary of one of `formats`, false
 * when it is not: binary by content, opening with a format's magic, and
 * holding no zip end record and no phar stub.
 */
export function knownBinarySize(blob: Buffer, formats: BinaryFormat[]): number | false {
  if (!holdsNul(blob)) return false;
  if (holdsZipEndRecord(blob) || holdsPharStub(blob)) return false;
  return opensWithMagic(blob, formats) && blob.length;
}

/**
 * Whether a file is skipped, given what each side of its diff is, `[base,
 * branch]`: a known binary's size, false, or undefined where the side does
 * not exist. It is skipped when every side it exists on is a known binary and
 * `budget` covers the branch side's bytes, which the skip then spends; a side
 * the branch deleted spends nothing.
 */
export function spendKnownBinarySkip(
  sides: (number | false | undefined)[],
  budget: { bytes: number },
): boolean {
  const known = sides.some((side) => typeof side === 'number') && !sides.includes(false);
  const spent = typeof sides[1] === 'number' ? sides[1] : 0;
  if (known && spent <= budget.bytes) {
    budget.bytes -= spent;
    return true;
  }
  return false;
}
