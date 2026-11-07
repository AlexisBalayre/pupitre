import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { transcriptDir } from '../claude/session-runtime.service.js';
import { openStore } from './db.client.js';
import { projectId } from './paths.utils.js';
import { buildRetro, writeRetro } from './retro.service.js';
import {
  formatRetro,
  type RetroReport,
  repoRelative,
  serializeRetro,
} from './retro-signals.utils.js';
import { ensureProject } from './session.repository.js';

const REPO = '/repo';
const T0 = Date.parse('2026-10-20T10:00:00Z');
const SECRET = 'sk-FAKE-SECRET-0123456789';
const EMPLOYER = 'Zorblax Industries';

function at(ms: number): string {
  return new Date(T0 + ms).toISOString();
}

function call(id: string, ms: number, tool?: { id: string; name: string; input: unknown }): string {
  return JSON.stringify({
    type: 'assistant',
    requestId: id,
    timestamp: at(ms),
    effort: 'high',
    message: {
      model: 'claude-opus-5-5',
      content: tool ? [{ type: 'tool_use', ...tool }] : [],
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 100,
        cache_creation: { ephemeral_1h_input_tokens: 100 },
        output_tokens: 20,
      },
    },
  });
}

function result(id: string, ms: number, text: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: at(ms),
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  });
}

describe('pup retro', () => {
  let db: Database;
  let claudeDir: string;

  function transcript(lines: string[], name = 'a.jsonl'): void {
    const dir = transcriptDir(`${REPO}/.worktrees/w1`, claudeDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), `${lines.join('\n')}\n`);
  }

  function retro(): RetroReport {
    return buildRetro(db, REPO, { since: new Date(T0 - 1000), claudeDirs: [claudeDir] });
  }

  beforeEach(() => {
    db = openStore(':memory:');
    ensureProject(db, projectId(REPO), REPO);
    claudeDir = mkdtempSync(join(tmpdir(), 'pup-retro-'));
  });

  afterEach(() => rmSync(claudeDir, { recursive: true, force: true }));

  it('buckets carried tool output by size and counts the requests that carry it', () => {
    transcript([
      call('r1', 0, { id: 't1', name: 'Bash', input: { command: 'ls' } }),
      result('t1', 1, 'x'.repeat(8_000)),
      call('r2', 2),
      call('r3', 3),
    ]);

    const [row] = retro().carry;

    expect(row).toMatchObject({ tool: 'Bash', sizeBucket: '1k-5k', results: 1, tokens: 2_000 });
    expect(row?.carriedTokens).toBe(4_000);
  });

  it('counts a file read three times in one session, by its path inside the repo', () => {
    const file = `${REPO}/.worktrees/w1/src/a.ts`;
    const lines = [1, 2, 3].flatMap((n) => [
      call(`r${n}`, n * 10, { id: `t${n}`, name: 'Read', input: { file_path: file } }),
      result(`t${n}`, n * 10 + 1, 'y'.repeat(400)),
    ]);
    transcript(lines);

    const report = retro();

    expect(report.filesReadRepeatedly).toBe(1);
    expect(report.repeatedReads).toEqual([
      { path: 'src/a.ts', sessions: 1, reads: 3, rereadTokens: 200 },
    ]);
  });

  it('counts the compactions inside the window', () => {
    transcript([
      call('r1', 0),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: at(5) }),
      call('r2', 10),
    ]);

    expect(retro().classes[0]?.compactions).toBe(1);
  });

  it('ranks findings by the tokens they cost', () => {
    transcript([
      call('r1', 0, { id: 't1', name: 'Bash', input: {} }),
      result('t1', 1, 'x'.repeat(100_000)),
      call('r2', 2),
      call('r3', 3),
    ]);

    const impacts = retro().findings.map((f) => f.impactTokens);

    expect(impacts).toEqual([...impacts].sort((a, b) => b - a));
    expect(retro().findings[0]?.signal).toBe('carried tool output');
  });

  it('keeps tool output, commands, prompts and outside paths out of every output', () => {
    transcript([
      JSON.stringify({
        type: 'user',
        timestamp: at(0),
        message: { content: `${EMPLOYER} ${SECRET}` },
      }),
      call('r1', 1, {
        id: 't1',
        name: 'Bash',
        input: { command: `curl -H "Authorization: ${SECRET}" https://${EMPLOYER}.example` },
      }),
      result('t1', 2, `${SECRET} ${EMPLOYER} `.repeat(2_000)),
      call('r2', 3, {
        id: 't2',
        name: 'Read',
        input: { file_path: `/home/someone/${EMPLOYER}/notes.md` },
      }),
      result('t2', 4, `${EMPLOYER} ${SECRET}`),
      call('r3', 5),
    ]);
    const report = retro();
    const outDir = join(claudeDir, 'out');

    const files = writeRetro(report, outDir, new Date(T0));
    const everything = [
      serializeRetro(report),
      formatRetro(report),
      readFileSync(files.markdown, 'utf8'),
      readFileSync(files.json, 'utf8'),
    ].join('\n');

    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(EMPLOYER);
    expect(everything).not.toContain('curl');
  });

  it('copies only the fields it names', () => {
    const report = { ...retro(), prompt: SECRET } as RetroReport;
    report.carry = [
      { tool: 'Bash', sizeBucket: '<1k', results: 1, tokens: 1, carriedTokens: 1, text: SECRET },
    ] as unknown as RetroReport['carry'];

    expect(serializeRetro(report)).not.toContain(SECRET);
  });

  it('writes the report owner-only under a dated name', () => {
    transcript([call('r1', 0)]);
    const outDir = join(claudeDir, 'out');

    const files = writeRetro(retro(), outDir, new Date('2026-10-21T08:00:00Z'));

    expect(files.markdown).toBe(join(outDir, 'retro-2026-10-21.md'));
    expect(statSync(files.json).mode & 0o777).toBe(0o600);
    expect(statSync(outDir).mode & 0o777).toBe(0o700);
  });
});

describe('repoRelative', () => {
  it('strips the repo or worktree root and reduces a path outside the repo to its basename', () => {
    expect(repoRelative('/repo/src/a.ts', '/repo')).toBe('src/a.ts');
    expect(repoRelative('/repo/.worktrees/w1/src/a.ts', '/repo')).toBe('src/a.ts');
    expect(repoRelative('/home/me/private/notes.md', '/repo')).toBe('notes.md');
  });

  it('replaces characters outside the path alphabet', () => {
    expect(repoRelative('src/a b\u001b[31m.ts', '/repo')).toBe('src/a?b??31m.ts');
  });
});
