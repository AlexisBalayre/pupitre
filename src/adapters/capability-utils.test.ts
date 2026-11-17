import { linkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import { describe, expect, it } from 'vitest';
import { readPlainFile } from './capability.utils.js';

describe('readPlainFile', () => {
  // A store file a session may have planted: a second name for it is a file
  // pup did not write there, which O_NOFOLLOW alone lets through (decision 194).
  it('refuses a file with a second hard link when asked for a sole link', () => {
    const dir = tempDir('pup-plain-');
    writeFileSync(join(dir, 'elsewhere'), 'someone else’s');
    linkSync(join(dir, 'elsewhere'), join(dir, 'handoff.md'));

    expect(() =>
      readPlainFile(join(dir, 'handoff.md'), { followLinks: false, soleLink: true }),
    ).toThrow(`${join(dir, 'handoff.md')} is not a plain file`);
  });

  // A test slot is taken by a link, so it has two names while the take is in
  // progress; refusing it would read as a dead holder's and reclaim a live slot.
  it('reads a hard-linked file without the sole-link check', () => {
    const dir = tempDir('pup-plain-');
    writeFileSync(join(dir, 'stage.tmp'), '{"pid":1}');
    linkSync(join(dir, 'stage.tmp'), join(dir, 'slot-0.lock'));

    expect(readPlainFile(join(dir, 'slot-0.lock'), { followLinks: false })).toBe('{"pid":1}');
  });
});
