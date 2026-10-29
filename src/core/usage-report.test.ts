import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { transcriptDir } from '../claude/session-runtime.service.js';
import { openStore } from './db.client.js';
import { projectId } from './paths.utils.js';
import { ensureProject } from './session.repository.js';
import { buildUsageReport, formatUsageReport } from './usage-report.service.js';

const REPO = '/repo';
const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-20T10:00:00Z');

interface Usage {
  input?: number;
  read?: number;
  write?: number;
  output?: number;
}

function assistant(
  requestId: string,
  atMs: number,
  model: string,
  effort: string,
  usage: Usage,
  tool?: { id: string; name: string },
): string {
  return JSON.stringify({
    type: 'assistant',
    requestId,
    timestamp: new Date(atMs).toISOString(),
    effort,
    message: {
      model,
      content: tool ? [{ type: 'tool_use', id: tool.id, name: tool.name }] : [],
      usage: {
        input_tokens: usage.input ?? 0,
        cache_read_input_tokens: usage.read ?? 0,
        cache_creation_input_tokens: usage.write ?? 0,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: usage.write ?? 0,
        },
        output_tokens: usage.output ?? 0,
      },
    },
  });
}

function toolResult(id: string, atMs: number, chars: number): string {
  return JSON.stringify({
    type: 'user',
    timestamp: new Date(atMs).toISOString(),
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(chars) }] },
  });
}

function prompt(text: string, atMs: number, entrypoint = 'cli'): string {
  return JSON.stringify({
    type: 'user',
    entrypoint,
    timestamp: new Date(atMs).toISOString(),
    message: { content: text },
  });
}

describe('buildUsageReport', () => {
  let db: Database;
  let claudeDir: string;

  function write(dir: string, name: string, lines: string[]): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), `${lines.join('\n')}\n`);
  }

  function report(sinceMs = T0 - HOUR): ReturnType<typeof buildUsageReport> {
    return buildUsageReport(db, REPO, { since: new Date(sinceMs), claudeDir });
  }

  beforeEach(() => {
    db = openStore(':memory:');
    ensureProject(db, projectId(REPO), REPO);
    claudeDir = mkdtempSync(join(tmpdir(), 'pup-usage-'));
  });

  afterEach(() => rmSync(claudeDir, { recursive: true, force: true }));

  it('classes transcripts and prints cost share, cache hit rate and context per class, model and effort', () => {
    write(transcriptDir(`${REPO}/.worktrees/w1`, claudeDir), 'a.jsonl', [
      prompt('do the task', T0),
      assistant('r1', T0, 'claude-sonnet-5-5', 'medium', { input: 10, write: 1000, output: 100 }),
      assistant('r2', T0 + 1000, 'claude-sonnet-5-5', 'medium', {
        input: 10,
        read: 1000,
        write: 500,
        output: 100,
      }),
    ]);
    write(transcriptDir(REPO, claudeDir), 'c.jsonl', [
      prompt('\n# Pupitre conductor pup-x — project y', T0),
      assistant('r1', T0, 'claude-opus-5-5', 'high', { input: 10, write: 2000, output: 50 }),
    ]);
    write(transcriptDir(REPO, claudeDir), 'o.jsonl', [
      prompt('hello', T0),
      assistant('r1', T0, 'claude-opus-5-5', 'high', { input: 10, write: 3000, output: 50 }),
    ]);
    write(transcriptDir(REPO, claudeDir), 'u.jsonl', [
      prompt('draft a record', T0, 'sdk-cli'),
      assistant('r1', T0, 'claude-haiku-5-5', 'unknown', { input: 100, output: 10 }),
    ]);
    write(join(transcriptDir(REPO, claudeDir), 'sess', 'subagents'), 'agent-1.jsonl', [
      assistant('r1', T0, 'claude-haiku-5-5', 'low', { input: 5, output: 5 }),
    ]);

    const result = report();

    expect(result.byClass.map((c) => c.class).sort()).toEqual(
      ['worker', 'conductor', 'console', 'utility', 'subagent'].sort(),
    );
    const worker = result.rows.find((r) => r.class === 'worker');
    expect(worker).toMatchObject({
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      calls: 2,
      medianContext: 1010,
      p90Context: 1510,
    });
    // read 1000 of 2520 prompt tokens (1010 + 1510)
    expect(worker?.cacheHitRate).toBeCloseTo(1000 / 2520);
    expect(result.rows.reduce((n, r) => n + r.costShare, 0)).toBeCloseTo(1);
    expect(formatUsageReport(result)).toContain('worker');
  });

  it('counts the first-request floor and the re-caches after an idle gap over an hour', () => {
    write(transcriptDir(`${REPO}/.worktrees/w1`, claudeDir), 'a.jsonl', [
      assistant('r1', T0, 'claude-opus-5-5', 'high', { input: 3, write: 40_000 }),
      assistant('r2', T0 + 60_000, 'claude-opus-5-5', 'high', {
        input: 3,
        read: 40_000,
        write: 100,
      }),
      // two hours idle: the cache expired and the whole context is written again
      assistant('r3', T0 + 2 * HOUR, 'claude-opus-5-5', 'high', { input: 3, write: 41_000 }),
      // a short gap that also writes more than it reads is not a re-cache
      assistant('r4', T0 + 2 * HOUR + 1000, 'claude-opus-5-5', 'high', { input: 3, write: 41_000 }),
    ]);
    write(transcriptDir(`${REPO}/.worktrees/w2`, claudeDir), 'b.jsonl', [
      assistant('r1', T0, 'claude-opus-5-5', 'high', { input: 3, write: 20_000 }),
    ]);

    const [row] = report().rows;

    expect(row).toMatchObject({
      calls: 5,
      recaches: 1,
      recachedTokens: 41_000,
      // first requests: 40003 and 20003
      firstRequestFloor: 20_003,
    });
  });

  it('counts one call per request id and reads only the window', () => {
    write(transcriptDir(`${REPO}/.worktrees/w1`, claudeDir), 'a.jsonl', [
      assistant('r1', T0, 'claude-opus-5-5', 'high', { input: 1, output: 5 }),
      assistant('r1', T0, 'claude-opus-5-5', 'high', { input: 1, output: 50 }),
      assistant('old', T0 - 10 * HOUR, 'claude-opus-5-5', 'high', { input: 1 }),
    ]);

    expect(report().rows[0]?.calls).toBe(1);
  });

  it('carries a tool result through every later call and lists models it cannot price', () => {
    write(transcriptDir(`${REPO}/.worktrees/w1`, claudeDir), 'a.jsonl', [
      assistant('r1', T0, 'claude-fable-5-1', 'high', { input: 1 }, { id: 't1', name: 'Bash' }),
      toolResult('t1', T0 + 1000, 400),
      assistant('r2', T0 + 2000, 'claude-fable-5-1', 'high', { input: 1 }),
      assistant('r3', T0 + 3000, 'claude-fable-5-1', 'high', { input: 1 }),
    ]);

    const result = report();

    expect(result.toolCarry).toEqual([
      { tool: 'Bash', results: 1, tokens: 100, carriedTokens: 200 },
    ]);
    expect(result.unpricedModels).toEqual(['claude-fable-5-1']);
  });

  it('prints the carry and the unpriced models, and skips a transcript it cannot read', () => {
    const dir = transcriptDir(`${REPO}/.worktrees/w1`, claudeDir);
    write(dir, 'a.jsonl', [
      assistant('r1', T0, 'claude-fable-5-1', 'high', { input: 1 }, { id: 't1', name: 'Read' }),
      toolResult('t1', T0 + 1000, 40),
      'not json',
      assistant('r2', T0 + 2000, 'claude-fable-5-1', 'high', { input: 1 }),
    ]);
    // a directory named like a transcript lists as one and cannot be read as one
    mkdirSync(join(dir, 'broken.jsonl'));

    const text = formatUsageReport(report());

    expect(text).toContain('Tool output carried');
    expect(text).toContain('Read: 1 results');
    expect(text).toContain('Unpriced (counted at $0, add to MODEL_PRICES): claude-fable-5-1');
  });

  it('reports an empty project without failing', () => {
    expect(report().rows).toEqual([]);
  });
});
