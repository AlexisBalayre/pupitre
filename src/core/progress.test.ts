import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatElapsed, NO_PROGRESS, stageProgress } from './progress.utils.js';

const STAGES = ['plan', 'merge lock', 'build'] as const;

/** A stream that keeps what it is handed, on a terminal or off one. */
function capture(isTTY: boolean) {
  const chunks: string[] = [];
  return { isTTY, write: (chunk: string) => chunks.push(chunk), chunks };
}

describe('formatElapsed', () => {
  it.each([
    [0, '0s'],
    [59_999, '59s'],
    [60_000, '1m 00s'],
    [184_000, '3m 04s'],
    [4_020_000, '1h 07m'],
    [-5, '0s'],
  ])('reads %i ms as %s', (ms, text) => {
    expect(formatElapsed(ms)).toBe(text);
  });
});

describe('stageProgress', () => {
  let clock: number;
  const now = () => clock;
  beforeEach(() => {
    clock = 1_000_000;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('prints one plain line per stage change off a terminal, with no escape code', () => {
    const stream = capture(false);
    const progress = stageProgress(STAGES, stream, now);

    progress.stage('plan');
    clock += 2_000;
    progress.stage('plan');
    progress.stage('merge lock');
    clock += 65_000;
    progress.stage('build');
    vi.advanceTimersByTime(5_000);
    progress.note('Waiting for the merge lock, held by pid 7, for up to 60.0s.');
    progress.end();

    expect(stream.chunks).toEqual([
      'stage 1/3, plan, 0s\n',
      'stage 2/3, merge lock, 2s\n',
      'stage 3/3, build, 1m 07s\n',
      'Waiting for the merge lock, held by pid 7, for up to 60.0s.\n',
    ]);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
    expect(stream.chunks.join('')).not.toMatch(/[\u001b\r]/);
  });

  it('rewrites one line in place on a terminal, ticking, and clears it at the end', () => {
    const stream = capture(true);
    const progress = stageProgress(STAGES, stream, now);

    progress.stage('build');
    clock += 1_000;
    vi.advanceTimersByTime(1_000);
    progress.note('a line of its own');
    progress.end();
    vi.advanceTimersByTime(5_000);

    expect(stream.chunks).toEqual([
      '\r\u001b[2Kstage 3/3, build, 0s',
      '\r\u001b[2Kstage 3/3, build, 1s',
      '\r\u001b[2Ka line of its own\n',
      '\r\u001b[2Kstage 3/3, build, 1s',
      '\r\u001b[2K',
    ]);
  });

  it('writes nothing on a terminal until a stage is shown, but a note', () => {
    const stream = capture(true);
    const progress = stageProgress(STAGES, stream, now);

    progress.note('before any stage');
    progress.end();

    expect(stream.chunks).toEqual(['before any stage\n']);
  });

  it('shows a stage outside the list by its name alone', () => {
    const stream = capture(false);

    stageProgress(STAGES, stream, now).stage('cleanup');

    expect(stream.chunks).toEqual(['cleanup, 0s\n']);
  });

  it('tells a watcher the current label, then each change, until it stops watching', () => {
    const progress = stageProgress(STAGES, capture(false), now);
    const labels: string[] = [];

    progress.stage('plan');
    const unwatch = progress.watch((label) => labels.push(label));
    progress.stage('merge lock');
    unwatch();
    progress.stage('build');

    expect(labels).toEqual(['stage 1/3, plan', 'stage 2/3, merge lock']);
  });
});

describe('NO_PROGRESS', () => {
  it('prints a note to stderr as before and nothing for a stage', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const labels: string[] = [];

    NO_PROGRESS.stage('plan');
    NO_PROGRESS.watch((label) => labels.push(label))();
    NO_PROGRESS.note('said');
    NO_PROGRESS.end();

    expect(errors.mock.calls).toEqual([['said']]);
    expect(labels).toEqual(['']);
    errors.mockRestore();
  });
});
