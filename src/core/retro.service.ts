import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';

import {
  buildRetroReport,
  formatRetro,
  type RetroReport,
  serializeRetro,
} from './retro-signals.utils.js';
import { scanUsage, type UsageOptions } from './usage-report.service.js';

export function buildRetro(db: Database, repoPath: string, opts: UsageOptions): RetroReport {
  return buildRetroReport(scanUsage(db, repoPath, opts), repoPath, opts.since);
}

export interface RetroFiles {
  markdown: string;
  json: string;
}

/**
 * The report is derived from private transcripts, so the folder and its files are
 * owner-only; the filename carries the date, and a second run on a day replaces
 * that day's report.
 */
export function writeRetro(report: RetroReport, outDir: string, now: Date): RetroFiles {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  chmodSync(outDir, 0o700);
  const stem = join(outDir, `retro-${now.toISOString().slice(0, 10)}`);
  const files = { markdown: `${stem}.md`, json: `${stem}.json` };
  writeFileSync(files.markdown, `${formatRetro(report)}\n`, { mode: 0o600 });
  writeFileSync(files.json, `${serializeRetro(report)}\n`, { mode: 0o600 });
  return files;
}
