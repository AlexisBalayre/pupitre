import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIEF_TEMPLATE, briefPath, ensureBrief, readBrief, workerBrief } from './brief.service.js';

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
});
