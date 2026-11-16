import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { skipsTestsOnUntestedChanges, workerSandboxOn } from './project-config.config.js';

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

  it('reads its own key beside the sandbox one', () => {
    const repo = repoWith('workerSandbox: true\nskipTestsOnUntestedChanges: false\n');
    expect(skipsTestsOnUntestedChanges(repo)).toBe(false);
  });
});

describe('workerSandboxOn', () => {
  it.each([
    { name: 'no project.yml', content: undefined },
    { name: 'an empty project.yml', content: '' },
    { name: 'a project.yml without the key', content: 'skipTestsOnUntestedChanges: false\n' },
  ])('keeps the sandbox off with $name', ({ content }) => {
    expect(workerSandboxOn(repoWith(content))).toBe(false);
  });

  it.runIf(process.platform === 'darwin')('reads the setting the project gives', () => {
    expect(workerSandboxOn(repoWith('workerSandbox: true\n'))).toBe(true);
    expect(workerSandboxOn(repoWith('workerSandbox: false\n'))).toBe(false);
  });

  it.each([
    { name: 'an unknown key', content: 'sandbox: true\n', error: /unknown key/ },
    {
      name: 'a value that is not a boolean',
      content: 'workerSandbox: "on"\n',
      error: /true or false/,
    },
  ])('refuses $name rather than leave the sandbox off', ({ content, error }) => {
    expect(() => workerSandboxOn(repoWith(content))).toThrow(error);
  });

  // Decision 191, ceiling 12: only macOS was probed, so the setting refuses elsewhere.
  it.each<{ platform: NodeJS.Platform; refused: boolean }>([
    { platform: 'darwin', refused: false },
    { platform: 'linux', refused: true },
    { platform: 'win32', refused: true },
    { platform: 'freebsd', refused: true },
  ])('refuses the setting outside macOS ($platform)', ({ platform, refused }) => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
    Object.defineProperty(process, 'platform', { ...original, value: platform });
    onTestFinished(() => {
      Object.defineProperty(process, 'platform', original);
    });
    const check = () => workerSandboxOn(repoWith('workerSandbox: true\n'));

    if (refused) expect(check).toThrow(/refused outside macOS/);
    else expect(check()).toBe(true);
    expect(workerSandboxOn(repoWith('workerSandbox: false\n'))).toBe(false);
  });
});
