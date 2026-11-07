import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Database } from 'better-sqlite3';

import { projectPaths } from './paths.utils.js';
import {
  buildRetroReport,
  formatRetro,
  type RetroReport,
  serializeRetro,
} from './retro-signals.utils.js';
import { scanUsage, type UsageOptions } from './usage-report.service.js';

const DAY_MS = 86_400_000;

/** `--since` as a day count: the window start, or undefined when the text is not a positive number. */
export function retroWindowStart(days: string, now: Date): Date | undefined {
  const count = Number(days);
  return Number.isFinite(count) && count > 0 ? new Date(now.getTime() - count * DAY_MS) : undefined;
}

export function buildRetro(db: Database, repoPath: string, opts: UsageOptions): RetroReport {
  return buildRetroReport(scanUsage(db, repoPath, opts), repoPath, opts.since);
}

/**
 * The report is derived from private transcripts, so the folder and its files are
 * owner-only; the filename carries the date, and a second run on a day replaces
 * that day's report. The Markdown file is for reading and the JSON one for the
 * next tool that reads it, so a retro always leaves both.
 */
export function writeRetro(
  report: RetroReport,
  repoPath: string,
  out: string | undefined,
  now: Date,
): { markdown: string; json: string } {
  const outDir = out ? resolve(out) : join(projectPaths(repoPath).root, 'retro');
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  chmodSync(outDir, 0o700);
  const stem = join(outDir, `retro-${now.toISOString().slice(0, 10)}`);
  const files = { markdown: `${stem}.md`, json: `${stem}.json` };
  writeFileSync(files.markdown, `${formatRetro(report)}\n`, { mode: 0o600 });
  writeFileSync(files.json, `${serializeRetro(report)}\n`, { mode: 0o600 });
  return files;
}
