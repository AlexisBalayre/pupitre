import { describe, expect, it } from 'vitest';
import { globToRegExp } from './glob.utils.js';

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
