import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BRIEF_MAX_CHARS,
  BRIEF_TEMPLATE,
  briefPath,
  ensureBrief,
  readBrief,
  workerBrief,
} from './brief.service.js';
import { InvalidProfileError } from './profile.errors.js';

const REPO = '/repo';

/** The brief a project already has, written where `briefPath` looks for it. */
function writeBrief(text: string): string {
  const path = briefPath(REPO);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

describe('the project brief on disk', () => {
  beforeEach(() => {
    // projectPaths resolves the brief under $HOME/.pupitre — a throwaway HOME
    // so a run never reads or writes the developer's real one.
    vi.stubEnv('HOME', realpathSync(mkdtempSync(join(tmpdir(), 'pup-brief-home-'))));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('has none until one is created, and then reads back what was written', () => {
    expect(readBrief(REPO)).toBeUndefined();

    const { path, created } = ensureBrief(REPO);

    expect(created).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(BRIEF_TEMPLATE);
    expect(readBrief(REPO)).toBe(BRIEF_TEMPLATE);
  });

  // The operator's words, never pup's: a second `pup brief edit` must open the
  // brief that exists, not overwrite it with the template again.
  it('leaves an existing brief alone', () => {
    writeBrief('## Destination\nShip the gate.\n');

    const { created } = ensureBrief(REPO);

    expect(created).toBe(false);
    expect(readBrief(REPO)).toBe('## Destination\nShip the gate.\n');
  });

  // A brief emptied out is a project that has none: it must compile exactly as
  // it did before there were briefs, not add a section of nothing.
  it('reports a whitespace-only brief as no brief at all', () => {
    writeBrief('\n  \n\t\n');

    expect(readBrief(REPO)).toBeUndefined();
  });

  /**
   * Every reader goes through `readBrief`: `pup brief show` prints it to the
   * operator's terminal and the kickoff pastes it into tmux. An escape
   * sequence would repaint the terminal, and a bracketed-paste terminator or a
   * bare carriage return would cut the paste short (decision 29's shape).
   */
  it('strips control characters, keeping newline and tab', () => {
    writeBrief('## Destination\r\n\u001b[2JShip\u0000 the\tgate.\u009b6n\n');

    expect(readBrief(REPO)).toBe('## Destination\n[2JShip the\tgate.6n\n');
  });

  // The bracketed-paste terminator, spelled out: the kickoff pastes the
  // compiled context, and this sequence would end the paste early and leave
  // the rest of the brief typed as commands.
  it('strips a bracketed-paste terminator', () => {
    writeBrief('## Destination\nShip it.\u001b[201~\n');

    expect(readBrief(REPO)).not.toContain('\u001b');
    expect(readBrief(REPO)).toBe('## Destination\nShip it.[201~\n');
  });

  /**
   * Refused here, naming the brief. The context budget would catch it a moment
   * later as a token count on the compiled result, which reads as "your task
   * spec is too long" and sends the operator to the wrong file.
   */
  it('refuses a brief over the cap, naming the file, its length and the fix', () => {
    const oversized = `## Destination\n${'x'.repeat(BRIEF_MAX_CHARS)}\n`;
    const path = writeBrief(oversized);

    expect(() => readBrief(REPO)).toThrow(InvalidProfileError);
    expect(() => readBrief(REPO)).toThrow(path);
    expect(() => readBrief(REPO)).toThrow(`is ${oversized.length} characters`);
    expect(() => readBrief(REPO)).toThrow(`over the ${BRIEF_MAX_CHARS}`);
    expect(() => readBrief(REPO)).toThrow('pup brief edit');
  });

  it('accepts a brief exactly at the cap', () => {
    writeBrief('x'.repeat(BRIEF_MAX_CHARS));

    expect(readBrief(REPO)).toHaveLength(BRIEF_MAX_CHARS);
  });

  // Measured after stripping, because that is the text every reader gets.
  it('measures the cap on the stripped text', () => {
    writeBrief('x'.repeat(BRIEF_MAX_CHARS) + '\u0000'.repeat(100));

    expect(readBrief(REPO)).toHaveLength(BRIEF_MAX_CHARS);
  });
});

describe('workerBrief', () => {
  it('keeps Destination and Constraints, demoted, and drops everything else', () => {
    const slice = workerBrief(
      '<!-- a comment -->\n\n' +
        '## Destination\nA control plane the operator trusts.\n\n' +
        '### Not a heading of its own\nstill Destination.\n\n' +
        '## Constraints\nNo new dependencies.\n\n' +
        '## Priorities\n1. The merge gate.\n',
    );

    expect(slice).toBe(
      '### Destination\nA control plane the operator trusts.\n\n' +
        '### Not a heading of its own\nstill Destination.\n\n' +
        '### Constraints\nNo new dependencies.',
    );
    expect(slice).not.toContain('a comment');
    expect(slice).not.toContain('merge gate');
  });

  it('matches the headings whatever their case', () => {
    expect(workerBrief('## DESTINATION\nnorth.\n')).toBe('### DESTINATION\nnorth.');
  });

  // A brief still on its template is direction nobody wrote; turning it into a
  // section of empty headings would put noise in every kickoff.
  it('is undefined when both headings are empty', () => {
    expect(workerBrief(BRIEF_TEMPLATE)).toBeUndefined();
  });

  // Free Markdown means the operator may rename or delete the headings. Then
  // there is nothing to carry, and the session's context says nothing rather
  // than guessing at which prose was meant for it.
  it('is undefined when the operator renamed the headings away', () => {
    expect(workerBrief('## Where we are going\nsomewhere.\n')).toBeUndefined();
  });

  /**
   * The leak a line-based split had: a fenced example of a brief, written under
   * Priorities, started a section there — and everything after it in the
   * Priorities went to every session.
   */
  it('ignores a heading inside a fenced code block', () => {
    const slice = workerBrief(
      '## Destination\nnorth.\n\n' +
        '## Priorities\nFor example:\n\n' +
        '```markdown\n## Destination\nsomewhere else\n```\n\n' +
        'and then the rest of the priorities.\n',
    );

    expect(slice).toBe('### Destination\nnorth.');
    expect(slice).not.toContain('somewhere else');
    expect(slice).not.toContain('rest of the priorities');
  });

  it('closes a fence only on the same character, and tildes fence too', () => {
    const slice = workerBrief(
      '## Priorities\n~~~\n```\n## Destination\nleaked\n~~~\n\n## Constraints\nnone.\n',
    );

    expect(slice).toBe('### Constraints\nnone.');
  });

  // A closing fence may carry nothing but whitespace after its run; a run with
  // text after it is content, so an example like `~~~ end of example` does not
  // end the fence early and let the heading after it start a real section.
  it('does not close a fence on a run followed by text', () => {
    const slice = workerBrief(
      '## Constraints\nnone.\n\n## Priorities\n~~~\n~~~ end of example\n## Destination\nleaked\n~~~\n',
    );

    expect(slice).toBe('### Constraints\nnone.');
  });

  // CommonMark allows up to three spaces before an ATX heading; an indented
  // heading that went unrecognised silently reached no session.
  it('accepts a heading indented by up to three spaces', () => {
    expect(workerBrief('   ## Constraints\nNo new dependencies.\n')).toBe(
      '### Constraints\nNo new dependencies.',
    );
    expect(workerBrief('    ## Constraints\nindented code, not a heading.\n')).toBeUndefined();
  });

  // CommonMark reads `## Constraints ##` as the same heading as `## Constraints`.
  // Not recognising it meant the constraints silently reached no session.
  it('accepts a closed ATX heading', () => {
    expect(workerBrief('## Constraints ##\nNo new dependencies.\n')).toBe(
      '### Constraints\nNo new dependencies.',
    );
  });

  // A `##` with no title still opens a section, so what follows cannot fall
  // back into the section above and reach a reader that one was not meant for.
  it('does not let a titleless heading leak Priorities into Constraints', () => {
    expect(workerBrief('## Constraints\nnone.\n\n##\n\nsecret priorities.\n')).toBe(
      '### Constraints\nnone.',
    );
  });

  it('keeps a deeper heading inside the section it was written under', () => {
    expect(workerBrief('## Destination\n### Later\nv2.\n')).toBe('### Destination\n### Later\nv2.');
  });
});
