import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { skipsTestsOnUntestedChanges } from './project-config.config.js';

/** A repo directory holding `.pupitre/project.yml` with `content`, or none when undefined. */
function repoWith(content?: string): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'pup-project-config-')));
  if (content !== undefined) {
    mkdirSync(join(repo, '.pupitre'));
    writeFileSync(join(repo, '.pupitre', 'project.yml'), content);
  }
  return repo;
}

describe('skipsTestsOnUntestedChanges', () => {
  it.each([
    { name: 'no project.yml', content: undefined },
    { name: 'an empty project.yml', content: '' },
  ])('keeps the skip on with $name', ({ content }) => {
    expect(skipsTestsOnUntestedChanges(repoWith(content))).toBe(true);
  });

  it('reads the setting the project gives', () => {
    expect(skipsTestsOnUntestedChanges(repoWith('skipTestsOnUntestedChanges: false\n'))).toBe(
      false,
    );
    expect(skipsTestsOnUntestedChanges(repoWith('skipTestsOnUntestedChanges: true\n'))).toBe(true);
  });

  it.each([
    { name: 'an unknown key', content: 'skipUntested: false\n', error: /unknown key/ },
    {
      name: 'a value that is not a boolean',
      content: 'skipTestsOnUntestedChanges: "no"\n',
      error: /true or false/,
    },
    { name: 'a list', content: '- false\n', error: /mapping/ },
  ])('refuses $name rather than leave the skip on', ({ content, error }) => {
    expect(() => skipsTestsOnUntestedChanges(repoWith(content))).toThrow(error);
  });
});
