import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sh } from '@test/helpers/git.mock.js';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import { describe, expect, it } from 'vitest';
import { readBlobs } from './git-blobs.client.js';

/** A repo whose one commit holds `files`. */
function repoWith(files: Record<string, Buffer | string>): string {
  const repo = tempDir('pup-blobs-');
  sh(repo, 'git', 'init', '-b', 'main');
  for (const [file, content] of Object.entries(files)) writeFileSync(join(repo, file), content);
  sh(repo, 'git', 'add', '.');
  sh(
    repo,
    'git',
    '-c',
    'user.email=blobs@test',
    '-c',
    'user.name=blobs-test',
    'commit',
    '-m',
    'blobs',
  );
  return repo;
}

function blobsOf(repo: string): { oid: string; size: number }[] {
  return sh(repo, 'git', 'ls-tree', '-r', '-l', '-z', 'HEAD')
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const [, , oid = '', size] = entry.slice(0, entry.indexOf('\t')).split(/ +/);
      return { oid, size: Number(size) };
    });
}

describe('readBlobs', () => {
  it('reads every blob byte for byte, a NUL, an empty one and a repeat included', () => {
    const files: Record<string, Buffer> = {
      'a.ts': Buffer.from('one\ntwo\n'),
      'b.bin': Buffer.from([0, 0x89, 0x0a, 0xff]),
      'empty.ts': Buffer.alloc(0),
      'no-eol.ts': Buffer.from('last'),
      'same.ts': Buffer.from('one\ntwo\n'),
    };
    const repo = repoWith(files);

    expect(readBlobs(repo, blobsOf(repo))).toEqual(Object.values(files));
  });

  it('reads no blob without running git', () => {
    expect(readBlobs('/nonexistent', [])).toEqual([]);
  });

  it('refuses an oid git does not hold', () => {
    const repo = repoWith({ 'a.ts': 'one\n' });

    expect(() => readBlobs(repo, [...blobsOf(repo), { oid: 'f'.repeat(40), size: 0 }])).toThrow(
      /missing/,
    );
  });

  it('refuses an answer whose size is not the one listed', () => {
    const repo = repoWith({ 'a.ts': 'one\n' });
    const [{ oid = '' } = {}] = blobsOf(repo);

    // One byte short overflows the buffer sized from the listing before any parse.
    expect(() => readBlobs(repo, [{ oid, size: 3 }])).toThrow(/ENOBUFS/);
    expect(() => readBlobs(repo, [{ oid, size: 5 }])).toThrow(/not a blob of 5 bytes/);
  });

  // `ls-tree -l` lists `BAD` for an object it cannot read, which reads as NaN.
  it('refuses, before running git, a size that is no byte count', () => {
    const repo = repoWith({ 'a.ts': 'one\n' });
    const [{ oid = '' } = {}] = blobsOf(repo);

    for (const size of [Number.NaN, -1, 1.5]) {
      expect(() => readBlobs(repo, [{ oid, size }])).toThrow(/no byte count for .*: its object/);
    }
  });

  // Each read alone was capped at 64 MiB; the batch holds them all at once.
  it('refuses, before running git, a batch whose sizes add past the cap', () => {
    const repo = repoWith({ 'a.ts': 'one\n' });
    const [{ oid = '' } = {}] = blobsOf(repo);
    const half = 32 * 1024 * 1024;

    expect(() =>
      readBlobs(repo, [
        { oid, size: half },
        { oid, size: half + 1 },
      ]),
    ).toThrow(/past the 67108864-byte cap/);
  });
});
