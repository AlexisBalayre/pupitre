import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
} from './retro-signals.service.js';
import { ensureProject } from './session.repository.js';
import { priceOf } from './usage-report.service.js';

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

    const files = writeRetro(report, REPO, outDir, new Date(T0));
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

  it('leaves an existing --out folder at its mode', () => {
    transcript([call('r1', 0)]);
    const outDir = join(claudeDir, 'shared');
    mkdirSync(outDir);
    chmodSync(outDir, 0o755);

    writeRetro(retro(), REPO, outDir, new Date(T0));

    expect(statSync(outDir).mode & 0o777).toBe(0o755);
  });

  it('prices re-caches as pup usage does, by cache tier', () => {
    const tier = (id: string, ms: number, write5m: number, write1h: number): string =>
      JSON.stringify({
        type: 'assistant',
        requestId: id,
        timestamp: at(ms),
        effort: 'high',
        message: {
          model: 'claude-opus-5-5',
          content: [],
          usage: {
            input_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: write5m + write1h,
            cache_creation: { ephemeral_1h_input_tokens: write1h },
            output_tokens: 1,
          },
        },
      });
    transcript([tier('r1', 0, 0, 100), tier('r2', 2 * 3_600_000, 4_000, 1_000)]);

    const row = retro().classes[0];
    const perToken = (priceOf('claude-opus-5-5')?.input ?? 0) / 1e6;

    expect(row?.recachedTokens).toBe(5_000);
    expect(row?.recacheCost).toBeCloseTo(perToken * (4_000 * 1.25 + 1_000 * 2), 10);
  });

  it('gives a compaction in a session that began before the window an impact', () => {
    const before = call('r0', -3_600_000);
    transcript([
      before,
      call('r1', 0),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: at(5) }),
      call('r2', 10),
    ]);

    const finding = retro().findings.find((f) => f.signal === 'context compactions');

    expect(finding?.impactTokens).toBe(1_010);
  });

  it('does not count a file read in chunks as read again, but a true repeat is', () => {
    const file = `${REPO}/.worktrees/w1/src/big.ts`;
    const read = (n: number, input: Record<string, unknown>): string[] => [
      call(`r${n}`, n * 10, { id: `t${n}`, name: 'Read', input: { file_path: file, ...input } }),
      result(`t${n}`, n * 10 + 1, 'y'.repeat(400)),
    ];
    transcript([
      ...read(1, { offset: 0, limit: 100 }),
      ...read(2, { offset: 100, limit: 100 }),
      ...read(3, { offset: 200, limit: 100 }),
    ]);
    expect(retro().filesReadRepeatedly).toBe(0);

    transcript(
      [
        ...read(1, { offset: 0, limit: 100 }),
        ...read(2, { offset: 0, limit: 100 }),
        ...read(3, { offset: 0, limit: 100 }),
      ],
      'b.jsonl',
    );
    expect(retro().repeatedReads.map((r) => r.path)).toEqual(['src/big.ts']);
  });

  it('keeps different outside files with one basename apart, but counts a real repeat', () => {
    const read = (n: number, dir: string): string[] => [
      call(`r${n}`, n * 10, {
        id: `t${n}`,
        name: 'Read',
        input: { file_path: `/home/me/${dir}/SKILL.md` },
      }),
      result(`t${n}`, n * 10 + 1, 'y'.repeat(400)),
    ];
    transcript([...read(1, 'a'), ...read(2, 'b'), ...read(3, 'c')]);
    expect(retro().filesReadRepeatedly).toBe(0);

    transcript([...read(1, 'a'), ...read(2, 'a'), ...read(3, 'a')], 'b.jsonl');
    expect(retro().repeatedReads.map((r) => r.path)).toEqual(['SKILL.md']);
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

    const files = writeRetro(retro(), REPO, outDir, new Date('2026-10-21T08:00:00Z'));

    expect(files.markdown).toBe(join(outDir, 'retro-2026-10-21.md'));
    expect(statSync(files.json).mode & 0o777).toBe(0o600);
    expect(statSync(outDir).mode & 0o777).toBe(0o700);
  });
});

type Row = RetroReport['classes'][number];
type Replay = Row['replay'][number];

describe('pup retro context replay', () => {
  let db: Database;
  let claudeDir: string;
  const MINUTE = 60_000;
  const GROWTH = 2_000;
  const INPUT = 10;

  function request(id: string, ms: number, read: number, write: number): string {
    return JSON.stringify({
      type: 'assistant',
      requestId: id,
      timestamp: at(ms),
      effort: 'high',
      message: {
        model: 'claude-opus-5-5',
        content: [],
        usage: {
          input_tokens: INPUT,
          cache_read_input_tokens: read,
          cache_creation_input_tokens: write,
          cache_creation: { ephemeral_1h_input_tokens: write },
          output_tokens: 400,
        },
      },
    });
  }

  function boundary(ms: number, trigger: string, preTokens?: number): string {
    return JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: at(ms),
      compactMetadata: { trigger, preTokens },
    });
  }

  /**
   * A worker that starts on a 20k floor, grows 2k a request, compacts when the
   * next request would reach the threshold (a summary of `posts[i]` tokens written after each),
   * and idles two hours once mid-way.
   */
  function worker(threshold: number, posts: number[], requests: number): string[] {
    const lines: string[] = [];
    let ms = 0;
    let context = 0;
    let compactions = 0;
    for (let n = 0; n < requests; n += 1) {
      ms += n === Math.floor(requests / 2) ? 2 * 3_600_000 : MINUTE;
      if (n === 0) {
        lines.push(request(`r${n}`, ms, 9_000, 11_000 - INPUT));
        context = 20_000;
      } else if (context + GROWTH >= threshold && compactions < posts.length) {
        lines.push(boundary(ms - 1, 'auto', context + GROWTH));
        const post = posts[compactions] ?? 0;
        compactions += 1;
        lines.push(request(`r${n}`, ms, 9_000, post - 9_000 - INPUT));
        context = post;
      } else if (n === Math.floor(requests / 2)) {
        context += GROWTH;
        lines.push(request(`r${n}`, ms, 0, context - INPUT));
      } else {
        lines.push(request(`r${n}`, ms, context, GROWTH - INPUT));
        context += GROWTH;
      }
    }
    return lines;
  }

  function retro(lines: string[]): RetroReport {
    const dir = transcriptDir(`${REPO}/.worktrees/w1`, claudeDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.jsonl'), `${lines.join('\n')}\n`);
    return buildRetro(db, REPO, { since: new Date(T0 - 1000), claudeDirs: [claudeDir] });
  }

  beforeEach(() => {
    db = openStore(':memory:');
    ensureProject(db, projectId(REPO), REPO);
    claudeDir = mkdtempSync(join(tmpdir(), 'pup-retro-replay-'));
  });

  afterEach(() => rmSync(claudeDir, { recursive: true, force: true }));

  it('replays the observed threshold within 5% of the actual spend', () => {
    const [row] = retro(worker(200_000, [24_000, 30_000], 250)).classes;

    expect(row?.compactions).toBe(2);
    expect(row?.observedThreshold).toBe(200_000);
    expect(row?.observedReplayCost).toBeGreaterThan(0);
    expect(Math.abs((row?.observedReplayCost ?? 0) / (row?.cost ?? 1) - 1)).toBeLessThan(0.05);
  });

  it('reports the context around compactions, growth and spend above 150k', () => {
    const [row] = retro(worker(200_000, [24_000, 30_000], 250)).classes;

    expect(row?.contextBeforeCompaction).toBe(200_000);
    expect(row?.contextAfterCompaction).toBe(24_000);
    expect(row?.growthPerRequest).toBeCloseTo(GROWTH, -2);
    expect(row?.highContextCostShare).toBeGreaterThan(0.2);
    expect(row?.highContextCostShare).toBeLessThan(0.8);
  });

  it('carries a replay at four thresholds in --json, a lower one saving with more resets', () => {
    const report = retro(worker(200_000, [24_000, 30_000], 250));
    const json = JSON.parse(serializeRetro(report)) as {
      classes: { replay: { threshold: number; resets: number; change: number }[] }[];
    };
    const replay = json.classes[0]?.replay ?? [];

    expect(replay.map((r) => r.threshold)).toEqual([100_000, 120_000, 150_000, 200_000]);
    expect(replay[0]?.change).toBeLessThan(0);
    expect(replay[0]?.change).toBeLessThan(replay[2]?.change ?? 0);
    expect(replay[0]?.resets).toBeGreaterThan(replay[3]?.resets ?? 0);
    expect(formatRetro(report)).toContain('100k');
  });

  it('reads a transcript with 150k compaction boundaries between two requests', () => {
    const boundaries = Array.from({ length: 150_000 }, () => boundary(MINUTE, 'auto', 300_000));
    const lines = [
      request('r0', 0, 9_000, 11_000),
      ...boundaries,
      request('r1', 2 * MINUTE, 9_000, 5_000),
    ];

    const [row] = retro(lines).classes;

    expect(row?.compactions).toBe(150_000);
    expect(row?.contextBeforeCompaction).toBe(300_000);
  });

  it('holds an absurd count at a ceiling, so no figure prints as Infinity or NaN', () => {
    const lines = [
      request('r0', 0, 1e308, 1e308),
      boundary(MINUTE - 1, 'auto', 1e308),
      request('r1', MINUTE, 1e308, 1e308),
    ];
    const report = retro(lines);

    expect(formatRetro(report)).not.toMatch(/Infinity|NaN/);
    expect(report.classes[0]?.contextBeforeCompaction).toBe(10_000_000);
  });

  it('keeps a /compact whatever the threshold, and reproduces a transcript with no reset', () => {
    const lines = [
      request('r0', 0, 9_000, 11_000 - INPUT),
      request('r1', MINUTE, 20_000, GROWTH - INPUT),
      boundary(2 * MINUTE - 1, 'manual'),
      request('r2', 2 * MINUTE, 9_000, 5_000 - INPUT),
      request('r3', 3 * MINUTE, 14_000, GROWTH - INPUT),
    ];
    const [row] = retro(lines).classes;
    const at200k = row?.replay.find((r) => r.threshold === 200_000);

    expect(row?.observedThreshold).toBe(0);
    expect(at200k?.resets).toBe(1);
    expect(at200k?.change).toBeCloseTo(0, 10);
    expect(row?.observedReplayCost).toBeCloseTo(row?.cost ?? 0, 10);
  });

  it('reads the carried context from the cache across an automatic compaction the replay skips', () => {
    const [uncompacted] = retro(worker(Number.POSITIVE_INFINITY, [], 80)).classes as [Row];
    const [compacted] = retro(worker(160_000, [24_000], 80)).classes as [Row];
    const [, , , at200k] = compacted.replay as [Replay, Replay, Replay, Replay];

    expect(compacted.compactions).toBe(1);
    expect(at200k.threshold).toBe(200_000);
    expect(at200k.resets).toBe(0);
    expect(Math.abs(at200k.cost / uncompacted.cost - 1)).toBeLessThan(0.01);
  });

  it('prices no lower threshold when no reset in the window gives a floor to restart from', () => {
    const report = retro([
      request('r0', -10 * MINUTE, 9_000, 100_000),
      ...Array.from({ length: 20 }, (_, n) =>
        request(`r${n + 1}`, (n + 1) * MINUTE, 109_000 + n * GROWTH, GROWTH - INPUT),
      ),
    ]);
    const [row] = report.classes as [Row];

    expect(row.replay).toEqual([]);
    expect(row.observedReplayCost).toBeCloseTo(row.cost, 10);
    expect(formatRetro(report)).toContain('no lower threshold priced');
  });
});

describe('repoRelative', () => {
  it('strips the repo or worktree root and reduces a path outside the repo to its basename', () => {
    expect(repoRelative('/repo/src/a.ts', '/repo')).toBe('src/a.ts');
    expect(repoRelative('/repo/.worktrees/w1/src/a.ts', '/repo')).toBe('src/a.ts');
    expect(repoRelative('/home/me/private/notes.md', '/repo')).toBe('notes.md');
  });

  it('reduces a relative path that leaves the repo, or a home path, to its basename', () => {
    expect(repoRelative('../other-repo/x.ts', '/repo')).toBe('x.ts');
    expect(repoRelative('src/../../secret-project/x.ts', '/repo')).toBe('x.ts');
    expect(repoRelative('~/secret-project/file.ts', '/repo')).toBe('file.ts');
    expect(repoRelative('/Users/someone/secret-project/file.ts', '/repo')).toBe('file.ts');
    expect(repoRelative('/repo/.worktrees/w1/../../../secret/x.ts', '/repo')).toBe('x.ts');
  });

  it('replaces characters outside the path alphabet', () => {
    expect(repoRelative('src/a b\u001b[31m.ts', '/repo')).toBe('src/a?b??31m.ts');
  });
});
