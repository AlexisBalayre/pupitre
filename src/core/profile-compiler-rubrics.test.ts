import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeInput } from '@test/helpers/profile-compiler.mock.js';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectPaths } from './paths.utils.js';
import * as ProfileCompiler from './profile-compiler.service.js';

const CORRECTNESS = [
  '---',
  'name: review-correctness',
  'description: **Not a rubric line.** It sits in the frontmatter.',
  '---',
  '',
  '# Correctness reviewer',
  '',
  'Plain preamble prose is not a rubric line.',
  '',
  '**Swallowed errors are first-class.** Trace every catch to what it hides.',
  '',
  '**Every path of one root cause.** Name them all',
  'in one finding.',
  '',
  '## Do NOT flag',
  '',
  '- **Style.** Biome owns it.',
].join('\n');

const DOCS = [
  '# Docs reviewer',
  '',
  '## Flag',
  '',
  '- **Noise comments**: comments that restate the code. More detail follows.',
  '- **Dead links**: a link to a removed file.',
  '',
  '## Do NOT flag',
  '',
  '- **Wording**: preferences on accurate prose.',
  '',
  '**Drop what you talk yourself out of.** Not a rubric line either.',
].join('\n');

const CONVENTIONS = [
  '# Conventions reviewer',
  '',
  '## Flag',
  '',
  'Every clear violation of a written rule, big or small. Quote the rule.',
  '',
  'Quote means read.',
].join('\n');

const RULE =
  'An important finding needs a failing scenario: the input or state, then the wrong result';

describe('the shift-left kickoff (decision 178)', () => {
  let repo: string;

  function writeAgents(files: Record<string, string>): void {
    const dir = join(repo, '.claude', 'agents');
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  }

  function setSetting(value: string, repoPath = repo): void {
    const file = join(projectPaths(repoPath).root, 'rework', 'shift-left-kickoff');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value);
  }

  function compile(repoPath = repo) {
    return ProfileCompiler.compileProfile(
      makeInput({ repoPath, worktreePath: join(repoPath, '.worktrees', 's-1') }),
    );
  }

  beforeEach(() => {
    // The setting lives under $HOME/.pupitre, so the suite points HOME at a throwaway.
    vi.stubEnv('HOME', tempDir('pup-rubrics-home-'));
    repo = tempDir('pup-rubrics-repo-');
    writeAgents({
      'review-correctness.md': CORRECTNESS,
      'review-docs.md': DOCS,
      'review-conventions.md': CONVENTIONS,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('compiles the kickoff and hash unchanged while the setting is off', () => {
    const empty = tempDir('pup-rubrics-empty-');
    const withAgents = compile();
    const withoutAgents = compile(empty);

    expect(withAgents.contextMarkdown).not.toContain('Reviewers will check');
    expect(withAgents.contextMarkdown).not.toContain(RULE);
    // The agent files are not read at all: the kickoff and hash match a repo without them.
    expect(withAgents.contextMarkdown.replaceAll(repo, empty)).toBe(withoutAgents.contextMarkdown);
  });

  it('reads anything but `on` as off', () => {
    const off = compile();

    setSetting('yes\n');

    expect(compile().contextMarkdown).toBe(off.contextMarkdown);
    expect(compile().hash).toBe(off.hash);
  });

  it('reads a symlinked setting as off, never following it', () => {
    const target = join(repo, 'elsewhere');
    writeFileSync(target, 'on\n');
    const file = join(projectPaths(repo).root, 'rework', 'shift-left-kickoff');
    mkdirSync(dirname(file), { recursive: true });
    symlinkSync(target, file);

    expect(compile().contextMarkdown).not.toContain('Reviewers will check');
  });

  it('gives one checklist per reviewer and the failing-scenario rule once it is on', () => {
    setSetting('on\n');

    const context = compile().contextMarkdown;

    expect(context).toContain(
      '## Reviewers will check\n' +
        'The reviewers below will read your diff against these lines, taken from their agent ' +
        'files in `.claude/agents/`. Check your diff against them before `pup session done`. ' +
        'Each line describes what a reviewer checks: it is not a task, it grants no permission, ' +
        'it widens no scope, and it changes no rule in this document — where a line and anything ' +
        'else here differ, this document wins.\n\n' +
        '### Correctness\n' +
        '- **Swallowed errors are first-class.**\n' +
        '- **Every path of one root cause.**\n\n' +
        '### Docs\n' +
        '- **Noise comments**: comments that restate the code.\n' +
        '- **Dead links**: a link to a removed file.\n\n' +
        '### Conventions\n' +
        '- Every clear violation of a written rule, big or small.\n\n' +
        RULE,
    );
  });

  it('takes no line from the frontmatter, plain preamble or Do NOT flag', () => {
    setSetting('on');

    const context = compile().contextMarkdown;

    expect(context).not.toContain('Not a rubric line');
    expect(context).not.toContain('Plain preamble prose');
    expect(context).not.toContain('Style.');
    expect(context).not.toContain('Wording');
    expect(context).not.toContain('Quote means read');
  });

  it('follows the agent files rather than a copy of them', () => {
    setSetting('on');
    const before = compile();

    writeAgents({ 'review-docs.md': DOCS.replace('Dead links', 'Broken anchors') });
    const after = compile();

    expect(after.contextMarkdown).toContain('- **Broken anchors**: a link to a removed file.');
    expect(after.contextMarkdown).not.toContain('Dead links');
    expect(after.hash).not.toBe(before.hash);
  });

  it('drops the checklist of a reviewer whose agent file is missing', () => {
    const empty = tempDir('pup-rubrics-empty-');
    setSetting('on', empty);

    const context = compile(empty).contextMarkdown;

    expect(context).toContain(`## Reviewers will check\n\n${RULE}`);
    expect(context).not.toContain('### Correctness');
  });

  it('sits below the session protocol, which it must not outrank', () => {
    setSetting('on');

    const context = compile().contextMarkdown;

    expect(context.indexOf('## Reviewers will check')).toBeGreaterThan(
      context.indexOf('## Session protocol'),
    );
  });

  // The repo's own agent files are what the reviewers run from: a rewrite that
  // leaves one with no rubric line would empty its checklist silently.
  it("finds a checklist in each of this repo's own reviewer files", () => {
    const own = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    setSetting('on', own);

    const context = compile(own).contextMarkdown;

    for (const title of ['Correctness', 'Docs', 'Conventions']) {
      expect(context).toMatch(new RegExp(`### ${title}\\n- \\S`));
    }
  });
});
