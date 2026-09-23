import { describe, expect, it } from 'vitest';
import { projectId, projectPaths } from './paths.utils.js';

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
