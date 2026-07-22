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
    expect(p.compiledDir('s1')).toBe(`${p.root}/sessions/s1/compiled`);
    expect(p.eventsFile('s1')).toBe(`${p.root}/sessions/s1/events.jsonl`);
  });
});
