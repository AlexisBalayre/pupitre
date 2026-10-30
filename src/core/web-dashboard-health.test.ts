import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { appendBaselineHistory } from './baseline-history.repository.js';
import { openStore } from './db.client.js';
import { DUPLICATION_RULE_ID } from './merge-gate.constants.js';
import { projectId } from './paths.utils.js';
import { appendEvent, ensureProject, insertSession, insertTask } from './session.repository.js';
import { readHealthSheet, renderHealthSheet } from './web-dashboard-health.service.js';

const REPO = '/repo';
const PR = 'https://github.com/o/r/pull/7';

describe('the Health sheet', () => {
  let db: Database;

  beforeEach(() => {
    db = openStore(':memory:');
    ensureProject(db, projectId(REPO), REPO);
  });

  const render = (): string => renderHealthSheet(readHealthSheet(db, REPO));

  function capture(
    capturedAt: string,
    debt: { dead?: number; lines?: number; ratio?: number; rule?: string },
  ): void {
    appendBaselineHistory(db, {
      projectId: projectId(REPO),
      capturedAt,
      stages: [],
      debt: {
        ...(debt.dead !== undefined
          ? {
              deadExports: Array.from({ length: debt.dead }, (_, i) => ({
                file: `src/f${i}.ts`,
                exportName: 'x',
              })),
            }
          : {}),
        ...(debt.lines !== undefined
          ? { duplicatedLines: debt.lines, duplicationRule: debt.rule ?? DUPLICATION_RULE_ID }
          : {}),
        ...(debt.ratio !== undefined ? { coverageRatio: debt.ratio } : {}),
      },
    });
  }

  /** A session's merge at `at` (SQLite's UTC text); `extra` merges record a fix round's re-gate. */
  function merge(sessionId: string, at: string, prUrl?: string, extra = 0): void {
    insertTask(db, {
      id: `t-${sessionId}`,
      projectId: projectId(REPO),
      spec: JSON.stringify({ id: `t-${sessionId}`, goal: 'g', scopeIn: ['src/**'] }),
      origin: 'human',
    });
    insertSession(db, {
      id: sessionId,
      taskId: `t-${sessionId}`,
      worktreePath: `/repo/.worktrees/${sessionId}`,
      branch: `pup/${sessionId}`,
      profileHash: 'hash',
    });
    for (let i = 0; i <= extra; i++) {
      appendEvent(db, sessionId, 'merge', {
        branch: `pup/${sessionId}`,
        target: 'main',
        files: [],
        ...(prUrl !== undefined ? { prUrl } : {}),
      });
    }
    db.prepare("UPDATE events SET created_at = ? WHERE session_id = ? AND type = 'merge'").run(
      at,
      sessionId,
    );
  }

  /** The `points` of every polyline in the chart titled `title`, one string per line. */
  function lines(page: string, title: string): string[] {
    const chart = new RegExp(`<title>${title}: [^<]*</title>(.*?)</svg>`).exec(page)?.[1] ?? '';
    return [...chart.matchAll(/<polyline class="line" points="([^"]*)"/g)].map(([, p]) => p ?? '');
  }

  it('says there is nothing to chart on an empty store, one line per section and no SVG', () => {
    const page = render();

    expect(page).not.toContain('<svg');
    expect(page).toContain('<p class="hint">No snapshot yet — `pup init` captures the first.</p>');
    expect(page).toContain('<p class="hint">No snapshot has moved a metric yet.</p>');
    expect(page).toContain('<p class="hint">No merge yet.</p>');
  });

  it('draws three snapshots as points on a time axis, with each merge marked by session and PR', () => {
    capture('2026-10-01T00:00:00.000Z', { dead: 4, lines: 100, ratio: 0.8 });
    capture('2026-10-03T00:00:00.000Z', { dead: 4, lines: 120, ratio: 0.82 });
    capture('2026-10-05T00:00:00.000Z', { dead: 2, lines: 120, ratio: 0.82 });
    merge('s-a', '2026-10-02 00:00:00', PR);
    // Re-gated after a fix round: still one merge, at the first.
    merge('s-b', '2026-10-04 00:00:00', undefined, 1);

    const page = render();

    expect(page).toContain(
      '<figcaption>coverage by snapshot: 2026-10-01 00:00 80% · 2026-10-03 00:00 82% · 2026-10-05 00:00 82%</figcaption>',
    );
    expect(page).toContain(
      '<figcaption>unused exports by snapshot: 2026-10-01 00:00 4 · 2026-10-03 00:00 4 · 2026-10-05 00:00 2</figcaption>',
    );
    // Placed by time across the plot (x 8 to 552), scaled to the series' own range (y 112 to 16).
    expect(lines(page, 'unused exports by snapshot')).toEqual(['8,16 280,16 552,112']);
    expect(lines(page, 'duplicated lines by snapshot')).toEqual(['8,112 280,16 552,16']);
    // Each chart marks both merges halfway between their snapshots.
    const markers = [...page.matchAll(/<line class="marker" x1="([\d.]+)"/g)].map(([, x]) => x);
    expect(markers).toEqual(['144', '416', '144', '416', '144', '416']);
    expect(page).toContain(
      `<a href="${PR}" target="_blank" rel="noopener noreferrer"><title>s-a merged 2026-10-02 00:00 — ${PR}</title>`,
    );
    expect(page).toContain('<g><title>s-b merged 2026-10-04 00:00</title>');
    expect(page).toContain('2 merged, oldest first');
  });

  it('breaks the line at a snapshot that left a metric unmeasured, and at a rule change, never drawing a zero', () => {
    capture('2026-10-01T00:00:00.000Z', { lines: 100, ratio: 0.8 });
    capture('2026-10-02T00:00:00.000Z', { lines: 110, ratio: 0.81 });
    capture('2026-10-03T00:00:00.000Z', { lines: 30, rule: 'older-rule' });
    capture('2026-10-04T00:00:00.000Z', { lines: 40, rule: 'older-rule', ratio: 0.85 });
    capture('2026-10-05T00:00:00.000Z', { lines: 45, rule: 'older-rule', ratio: 0.86 });

    const page = render();

    expect(page).toContain(
      'coverage by snapshot: 2026-10-01 00:00 80% · 2026-10-02 00:00 81% · 2026-10-03 00:00 not measured · 2026-10-04 00:00 85% · 2026-10-05 00:00 86%',
    );
    expect(lines(page, 'coverage by snapshot')).toEqual(['8,112 144,96', '416,32 552,16']);
    // The count under another rule starts a line of its own, so no drop is drawn as a move.
    expect(lines(page, 'duplicated lines by snapshot')).toEqual([
      '8,28 144,16',
      '280,112 416,100 552,94',
    ]);
    expect(page).toContain('<p class="hint">unused exports: not measured in any snapshot.</p>');
  });

  it('ranks the snapshots that moved a metric most, naming the sessions merged since the one before', () => {
    capture('2026-10-01T00:00:00.000Z', { dead: 0, lines: 100, ratio: 0.8 });
    // Duplication +10%, the smallest move; coverage unmeasured here and next,
    // so the snapshot after compares it with the first.
    capture('2026-10-03T00:00:00.000Z', { dead: 0, lines: 110 });
    capture('2026-10-05T00:00:00.000Z', { dead: 0, lines: 110 });
    // Unused exports leave zero, the largest move; coverage rose since 10-01.
    capture('2026-10-07T00:00:00.000Z', { dead: 3, lines: 110, ratio: 0.9 });
    capture('2026-10-09T00:00:00.000Z', { dead: 3, lines: 110, ratio: 0.9 });
    merge('s-early', '2026-10-02 00:00:00', PR);
    merge('s-late', '2026-10-06 00:00:00');
    merge('s-gap', '2026-10-04 00:00:00', 'https://evil.example/x');

    const page = render();
    const rows = [...page.matchAll(/<tr><td>([^<]*)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/g)];

    expect(rows.map(([, at]) => at)).toEqual(['2026-10-07 00:00', '2026-10-03 00:00']);
    expect(rows[0]?.[2]).toBe(
      '<div>coverage 80% → 90% (+10 pt)</div><div>unused exports 0 → 3 (+3)</div>',
    );
    // Coverage's window reaches back to 10-01, past the gap, so both later merges are named, newest first.
    expect(rows[0]?.[3]).toBe(
      '<div><span class="sid">s-late</span></div><div><span class="sid">s-gap</span> <code>https://evil.example/x</code></div><div><span class="sid">s-early</span> ' +
        `<a href="${PR}" target="_blank" rel="noopener noreferrer">${PR}</a></div>`,
    );
    expect(rows[1]?.[3]).toContain('<span class="sid">s-early</span>');
    expect(rows[1]?.[3]).not.toContain('s-gap');
    // The only link off the sheet is a pull request's.
    expect(page).not.toMatch(/<a href="(?!https:\/\/github\.com\/o\/r\/pull\/7")/);
  });

  it('escapes the session ids and PR urls it shows, markup and control characters alike', () => {
    const evil = '<img src=x onerror=alert(1)>\u001b[31m\u009b2J‮';
    capture('2026-10-01T00:00:00.000Z', { lines: 1 });
    capture(`2026-10-02T00:00:00.000Z${evil}`, { lines: 2 });
    merge('s-pr', '2026-10-01 12:00:00', `${PR}${evil}`);
    merge(`s-${evil}`, '2026-10-01 13:00:00', evil);

    const page = render();

    expect(page).not.toContain('<img');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: their absence is what is asserted
    expect(page).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‮]/);
    expect(page).toContain(`<code>${PR}&lt;img src=x onerror=alert(1)&gt;`);
    expect(page).toContain('<span class="sid">(unminted session id)</span>');
    // The capture whose time does not parse has no place on the axis.
    expect(page).toContain(
      '<figcaption>duplicated lines by snapshot: 2026-10-01 00:00 1</figcaption>',
    );
  });
});
