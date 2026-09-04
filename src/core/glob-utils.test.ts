import { describe, expect, it } from 'vitest';
import { globsToGrepFile, globToRegExp } from './glob.utils.js';

describe('globToRegExp', () => {
  it.each([
    ['src/net/**', 'src/net/retry.service.ts', true],
    ['src/net/**', 'src/net/deep/nested/file.ts', true],
    ['src/net/**', 'src/cli/index.ts', false],
    ['src/*.ts', 'src/index.ts', true],
    ['src/*.ts', 'src/core/index.ts', false],
    ['**/*.test.ts', 'src/core/db-client.test.ts', true],
    ['**/*.test.ts', 'db-client.test.ts', true],
    ['**/*.test.ts', 'src/core/db.client.ts', false],
    ['docs/', 'docs/00-overview.md', true],
    ['file?.ts', 'file1.ts', true],
    ['file?.ts', 'file12.ts', false],
  ])('%s vs %s -> %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });

  it('escapes regex specials so dots are literal', () => {
    expect(globToRegExp('src/db.client.ts').test('src/dbxclient.ts')).toBe(false);
  });
});

describe('globsToGrepFile', () => {
  // `grep -qE -f` treats a blank pattern line as matching every input, so one
  // empty line turns a scope allowlist into allow-all. The line does not come
  // from a blank array element (a converted glob is always `^…$`) but from
  // inside a glob carrying a newline, which expands into two lines.
  it('drops a glob carrying a newline rather than splitting it', () => {
    expect(globsToGrepFile(['src/**\n\nfoo/**'])).toBe('');
    expect(globsToGrepFile(['src/**', 'bad\nglob'])).toBe('^src/.*$\n');
  });

  it('writes an empty file when there is nothing to allow', () => {
    expect(globsToGrepFile([])).toBe('');
  });

  // The property that matters is not the file's shape but that no pattern in it
  // matches a path the globs never named.
  it.each([['src/**\n\nfoo/**'], ['   '], ['']])(
    'emits no pattern matching a path the globs never named, for %j',
    (glob) => {
      const patterns = globsToGrepFile([glob]).split('\n').filter(Boolean);

      expect(patterns.some((p) => new RegExp(p).test('secrets/creds.env'))).toBe(false);
    },
  );

  it('still writes one anchored pattern per ordinary glob', () => {
    expect(globsToGrepFile(['src/**', 'docs/**']).trimEnd().split('\n')).toHaveLength(2);
  });
});
