import { describe, expect, it } from 'vitest';
import { scopeInFiles } from './task-spec.utils.js';

describe('scopeInFiles (decision 126)', () => {
  const tracked = [
    'src/core/land.service.ts',
    'src/core/land.test.ts',
    'src/core/landing/inner.ts',
    'src/core/legacy/land.ts',
    '.claude/settings.json',
  ];

  it('returns the tracked files the scope-in matches, in tracked order', () => {
    expect(scopeInFiles(tracked, { scopeIn: ['src/core/land*.ts'] })).toEqual({
      files: ['src/core/land.service.ts', 'src/core/land.test.ts'],
      toCreate: [],
    });
  });

  it('drops what scope-out takes back and the protected paths, as the gate does', () => {
    const { files } = scopeInFiles(tracked, {
      scopeIn: ['src/core/**', '.claude/**'],
      scopeOut: ['src/core/legacy/**'],
    });

    expect(files).toEqual([
      'src/core/land.service.ts',
      'src/core/land.test.ts',
      'src/core/landing/inner.ts',
    ]);
  });

  it('names each glob no editable file matches as one to create, and ignores blank globs', () => {
    expect(
      scopeInFiles(tracked, {
        scopeIn: ['src/core/land.ts', ' ', 'src/core/legacy/*.ts', 'src/core/land.test.ts'],
        scopeOut: ['src/core/legacy/**'],
      }),
    ).toEqual({
      files: ['src/core/land.test.ts'],
      toCreate: ['src/core/land.ts', 'src/core/legacy/*.ts'],
    });
  });
});
