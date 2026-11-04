import { describe, expect, it } from 'vitest';
import { scopeInFiles } from './task-spec.utils.js';

describe('scopeInFiles (decision 128)', () => {
  const NO_DEADLINE = Number.POSITIVE_INFINITY;
  const tracked = [
    'src/core/land.service.ts',
    'src/core/land.test.ts',
    'src/core/landing/inner.ts',
    'src/core/legacy/land.ts',
    '.claude/settings.json',
  ];

  it('returns the tracked files the scope-in matches, in tracked order', () => {
    expect(scopeInFiles(tracked, { scopeIn: ['src/core/land*.ts'] }, NO_DEADLINE)).toEqual({
      files: ['src/core/land.service.ts', 'src/core/land.test.ts'],
      toCreate: [],
    });
  });

  it('drops what scope-out takes back and the protected paths, as the gate does', () => {
    const scope = scopeInFiles(
      tracked,
      {
        scopeIn: ['src/core/**', '.claude/**'],
        scopeOut: ['src/core/legacy/**'],
      },
      NO_DEADLINE,
    );

    expect(scope?.files).toEqual([
      'src/core/land.service.ts',
      'src/core/land.test.ts',
      'src/core/landing/inner.ts',
    ]);
  });

  it('names a glob that matches no tracked path as one to create, and ignores blank globs', () => {
    expect(
      scopeInFiles(
        tracked,
        { scopeIn: ['src/core/land.ts', ' ', 'src/core/land.test.ts'] },
        NO_DEADLINE,
      ),
    ).toEqual({
      files: ['src/core/land.test.ts'],
      toCreate: ['src/core/land.ts'],
    });
  });

  // `pup new --scope` stores a glob as typed; globToRegExp trims it and drops a leading `./`.
  it('offers for creation a new file whose glob is ./-prefixed or space-padded', () => {
    expect(
      scopeInFiles(
        tracked,
        {
          scopeIn: ['./src/core/new.ts', ' src/core/other.ts ', './.claude/new.md'],
          scopeOut: [],
        },
        NO_DEADLINE,
      ),
    ).toEqual({ files: [], toCreate: ['./src/core/new.ts', ' src/core/other.ts '] });
  });

  // The hook would refuse what it names, so it is neither listed nor offered for creation.
  it('never offers for creation a glob only protected or scope-out paths answer', () => {
    expect(
      scopeInFiles(
        tracked,
        {
          scopeIn: [
            'src/core/legacy/*.ts',
            'src/core/legacy/new.ts',
            '.claude/**',
            '.claude/new.md',
          ],
          scopeOut: ['src/core/legacy/**'],
        },
        NO_DEADLINE,
      ),
    ).toEqual({ files: [], toCreate: [] });
  });

  // The listing is the repo's, which a session can plant to be huge.
  it('gives up once its deadline passes', () => {
    expect(scopeInFiles(tracked, { scopeIn: ['src/**'] }, Date.now() - 1)).toBeUndefined();
  });
});
