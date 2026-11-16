import { GIT_MAX_BUFFER, GIT_READ_TIMEOUT_MS, runGitBytes } from './git-diff.client.js';

/**
 * The content of each blob in `blobs`, in order, read through one
 * `git cat-file --batch` however many there are: a process per blob let a
 * tree of 20 000 tiny files hold the merge lock for minutes (decision 154).
 * Sizes are the ones git listed (`ls-tree -l`, `cat-file -s`), and together they may not pass
 * `GIT_MAX_BUFFER`, the cap each read had alone: past it, or past
 * `GIT_READ_TIMEOUT_MS`, this throws and the gate fails closed. A size that
 * is no byte count, which `ls-tree` lists for an object it cannot read, throws,
 * and so does an answer that is not the oid asked for, a blob of the size listed.
 * The output buffer is sized exactly, so a byte past the last blob overflows it
 * and throws too.
 */
export function readBlobs(repoPath: string, blobs: { oid: string; size: number }[]): Buffer[] {
  if (blobs.length === 0) return [];
  let total = 0;
  let maxBuffer = 0;
  for (const { oid, size } of blobs) {
    // `ls-tree -l` lists `BAD` for an object it cannot read.
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`git ls-tree listed no byte count for ${oid}: its object cannot be read`);
    }
    total += size;
    // Each object prints as `<oid> blob <size>\n<content>\n`.
    maxBuffer += size + oid.length + ` blob ${size}\n\n`.length;
  }
  if (total > GIT_MAX_BUFFER) {
    throw new Error(
      `git cat-file --batch would read ${total} bytes, past the ${GIT_MAX_BUFFER}-byte cap`,
    );
  }
  const out = runGitBytes(repoPath, ['cat-file', '--batch'], {
    input: Buffer.from(`${blobs.map(({ oid }) => oid).join('\n')}\n`),
    maxBuffer,
    timeout: GIT_READ_TIMEOUT_MS,
  });
  const contents: Buffer[] = [];
  let at = 0;
  for (const { oid, size } of blobs) {
    const eol = out.indexOf('\n', at);
    const header = out.subarray(at, eol === -1 ? out.length : eol).toString('utf8');
    const end = eol + 1 + size;
    if (eol === -1 || header !== `${oid} blob ${size}` || out[end] !== 0x0a) {
      throw new Error(
        `git cat-file --batch answered ${JSON.stringify(header)} for ${oid}, not a blob of ${size} bytes`,
      );
    }
    contents.push(out.subarray(eol + 1, end));
    at = end + 1;
  }
  return contents;
}
