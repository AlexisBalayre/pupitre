import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import { describe, expect, it } from 'vitest';
import { projectId, projectPaths, writeStoreFile } from './paths.utils.js';

describe('paths', () => {
  it('derives a stable, path-specific project id', () => {
    expect(projectId('/repo/a')).toBe(projectId('/repo/a'));
    expect(projectId('/repo/a')).not.toBe(projectId('/repo/b'));
    expect(projectId('/repo/a')).toHaveLength(12);
  });

  it('lays out per-session directories under the project root', () => {
    const p = projectPaths('/repo/a', '/base');
    expect(p.root).toBe(`/base/${projectId('/repo/a')}`);
    expect(p.dbFile).toBe(`${p.root}/state.db`);
    expect(p.sessionDir('s1')).toBe(`${p.root}/sessions/s1`);
    expect(p.compiledDir('s1')).toBe(`${p.root}/sessions/s1/compiled`);
    expect(p.eventsFile('s1')).toBe(`${p.root}/sessions/s1/events.jsonl`);
    expect(p.handoffFile('s1')).toBe(`${p.root}/sessions/s1/handoff.md`);
  });

  describe('session id as a path fragment (decision 66)', () => {
    // One per builder: `sessionDir` is where the check lives, and the other
    // three are only safe because they compose it.
    const builders = ['sessionDir', 'compiledDir', 'eventsFile', 'handoffFile'] as const;

    it.each(builders)('%s builds a path for an id from the closed charset', (builder) => {
      const p = projectPaths('/repo/a', '/base');
      expect(p[builder]('t-msdc5rls_1')).toContain(`${p.sessionsDir}/t-msdc5rls_1`);
    });

    it.each(builders)('%s refuses an id that would escape the sessions dir', (builder) => {
      const p = projectPaths('/repo/a', '/base');
      expect(() => p[builder]('../../marker')).toThrow(/not a usable path fragment/);
    });

    it.each(['a/b', 'a.b', '', 'a'.repeat(65), '\u0000'])('refuses the id %j', (id) => {
      expect(() => projectPaths('/repo/a', '/base').sessionDir(id)).toThrow();
    });

    it('names the offending id in the refusal, sanitized for the terminal', () => {
      // The id is store-written text on its way to an operator's terminal, so
      // the escape that repaints their screen never reaches it (decision 29).
      expect(() => projectPaths('/repo/a', '/base').sessionDir('../\u001b[2Kevil')).toThrow(
        'Session id "../ [2Kevil" is not a usable path fragment',
      );
    });
  });
});

describe('writeStoreFile (decision 194)', () => {
  it('replaces a symlink with a fresh file and leaves its target alone', () => {
    const dir = tempDir('pup-store-');
    const target = join(tempDir('pup-elsewhere-'), 'target');
    writeFileSync(target, 'untouched');
    symlinkSync(target, join(dir, 'brief.md'));

    writeStoreFile(join(dir, 'brief.md'), 'pup wrote this');

    expect(readFileSync(target, 'utf8')).toBe('untouched');
    expect(lstatSync(join(dir, 'brief.md')).isFile()).toBe(true);
    expect(readFileSync(join(dir, 'brief.md'), 'utf8')).toBe('pup wrote this');
  });

  it('does not create the target of a dangling link', () => {
    const dir = tempDir('pup-store-');
    const target = join(tempDir('pup-elsewhere-'), 'created');
    symlinkSync(target, join(dir, 'usage.json'));

    writeStoreFile(join(dir, 'usage.json'), '{}');

    expect(existsSync(target)).toBe(false);
  });

  it('sets the mode it is given exactly, and refuses a directory in the way', () => {
    const dir = tempDir('pup-store-');
    writeStoreFile(join(dir, 'hook.sh'), '#!/bin/sh\n', 0o755);
    mkdirSync(join(dir, 'taken'));

    expect(lstatSync(join(dir, 'hook.sh')).mode & 0o777).toBe(0o755);
    expect(() => writeStoreFile(join(dir, 'taken'), 'x')).toThrow();
    expect(lstatSync(join(dir, 'taken')).isDirectory()).toBe(true);
  });
});
