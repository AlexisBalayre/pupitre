import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { latestContextTokens } from './transcript.service.js';

function makeTranscriptDir(lines: object[]): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pup-transcript-')));
  writeFileSync(join(dir, 'session.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  return dir;
}

describe('latestContextTokens', () => {
  it('sums input and cache tokens from the newest assistant entry', () => {
    const dir = makeTranscriptDir([
      { type: 'user', message: { content: 'hi' } },
      {
        type: 'assistant',
        message: { usage: { input_tokens: 10, cache_read_input_tokens: 5 } },
      },
      {
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 80_000,
            cache_creation_input_tokens: 4_000,
            output_tokens: 999,
          },
        },
      },
      { type: 'user', message: { content: 'more' } },
    ]);

    expect(latestContextTokens(dir)).toBe(84_100);
  });

  it('skips malformed lines and returns undefined when no usage exists', () => {
    const dir = makeTranscriptDir([{ type: 'user', message: { content: 'only' } }]);
    writeFileSync(join(dir, 'broken.jsonl'), 'not json\n{"type":"user"}');

    expect(latestContextTokens(dir)).toBeUndefined();
  });

  it('returns undefined for a missing directory', () => {
    expect(latestContextTokens('/nonexistent/transcripts')).toBeUndefined();
  });
});
