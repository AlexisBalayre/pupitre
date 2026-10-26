import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { type IncomingHttpHeaders, request } from 'node:http';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tmux boundary only: the store, the server and its socket all run for
// real, per docs/conventions/testing.md.
vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  hasConductorWindow: vi.fn(() => false),
}));

import { hasConductorWindow } from '../claude/session-runtime.service.js';
import { tempDir } from '../test/temp-dir.mock.js';
import { formatDebtTransition } from './audit.service.js';
import { appendBaselineHistory } from './baseline-history.repository.js';
import { briefPath } from './brief.service.js';
import { buildDashboardSnapshot, needsYou } from './dashboard.service.js';
import type { SessionState } from './db.client.js';
import { openStore } from './db.client.js';
import { persistBaseline } from './init.service.js';
import { insertLedgerEntry, listLedgerEntries } from './ledger.repository.js';
import { DUPLICATION_RULE_ID } from './merge-gate.constants.js';
import { projectId, projectPaths } from './paths.utils.js';
import {
  appendEvent,
  ensureProject,
  incrementRejectCount,
  insertSession,
  insertTask,
  recordSessionRoute,
  transitionSession,
} from './session.repository.js';
import { STALLED_AFTER_MS } from './session-activity.constants.js';
import { startWebDashboard, type WebDashboard } from './web-dashboard.service.js';
import { escapeHtml } from './web-dashboard-sheet.utils.js';

const POLL_MS = 300;
const PR = 'https://github.com/o/r/pull/7';

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** One request over the real socket, with the Host header the test names. */
function get(url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** An open event stream: every `data:` frame it has received, decoded, and a way to wait for the next. */
function openStream(url: string): Promise<{
  frames: string[];
  next: () => Promise<string>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const frames: string[] = [];
    let waiting: ((frame: string) => void) | undefined;
    let buffer = '';
    const req = request(url, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let end = buffer.indexOf('\n\n');
        while (end !== -1) {
          const frame = JSON.parse(buffer.slice(0, end).replace(/^data: /, '')) as string;
          buffer = buffer.slice(end + 2);
          frames.push(frame);
          waiting?.(frame);
          waiting = undefined;
          end = buffer.indexOf('\n\n');
        }
      });
      resolve({
        frames,
        next: () =>
          new Promise((done) => {
            waiting = done;
          }),
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('startWebDashboard', () => {
  let db: Database;
  let repo: string;
  let dashboard: WebDashboard;

  beforeEach(async () => {
    vi.stubEnv('HOME', tempDir('pup-web-home-'));
    db = openStore(':memory:');
    repo = tempDir('pup-web-');
    ensureProject(db, projectId(repo), repo);
    dashboard = await startWebDashboard(db, repo, { pollMs: POLL_MS });
  });

  afterEach(async () => {
    await dashboard.close();
    db.close();
    vi.unstubAllEnvs();
    vi.mocked(hasConductorWindow).mockReset();
  });

  function seedSession(
    sessionId: string,
    path: SessionState[],
    goal = `goal for ${sessionId}`,
  ): void {
    const taskId = `t-${sessionId}`;
    insertTask(db, {
      id: taskId,
      projectId: projectId(repo),
      spec: JSON.stringify({ id: taskId, goal, scopeIn: ['src/**'], acceptance: ['done'] }),
      origin: 'human',
    });
    insertSession(db, {
      id: sessionId,
      taskId,
      worktreePath: join(repo, '.worktrees', sessionId),
      branch: `pup/${sessionId}`,
      profileHash: 'hash',
    });
    for (const state of path) transitionSession(db, sessionId, state);
  }

  /** A `--pr` merge whose pinned sha this temp dir, no git repo, cannot show landed. */
  function seedMerge(sessionId: string, prUrl: string): void {
    seedSession(sessionId, ['running', 'awaiting-review', 'merged']);
    appendEvent(db, sessionId, 'merge', {
      branch: `pup/${sessionId}`,
      sha: 'f'.repeat(40),
      target: 'main',
      files: ['src/a.ts'],
      prUrl,
    });
  }

  /** One hook event on disk, the file's mtime aged by `ageMs` (decision 35). */
  function seedHookEvent(sessionId: string, events: object | object[], ageMs = 0): void {
    const paths = projectPaths(repo);
    mkdirSync(paths.sessionDir(sessionId), { recursive: true });
    const lines = (Array.isArray(events) ? events : [events]).map((event) => JSON.stringify(event));
    writeFileSync(paths.eventsFile(sessionId), `${lines.join('\n')}\n`);
    const at = new Date(Date.now() - ageMs);
    utimesSync(paths.eventsFile(sessionId), at, at);
  }

  const address = (): URL => new URL(dashboard.url);
  const eventsUrl = (): string => `${address().origin}/events${address().search}`;
  const host = (): string => address().host;
  const origin = (): string => address().origin;

  describe('who it answers', () => {
    it('binds the loopback address and prints a url with a random token', async () => {
      const url = address();
      const other = await startWebDashboard(db, repo, { pollMs: POLL_MS });
      try {
        expect(url.hostname).toBe('127.0.0.1');
        expect(url.searchParams.get('token')).toMatch(/^[\w-]{43}$/);
        expect(new URL(other.url).searchParams.get('token')).not.toBe(
          url.searchParams.get('token'),
        );
        expect((await get(dashboard.url)).status).toBe(200);
      } finally {
        await other.close();
      }
    });

    it.each([
      ['no token', (url: URL) => `${url.origin}/`],
      ['a wrong token', (url: URL) => `${url.origin}/?token=${'A'.repeat(43)}`],
      ['a token one character short', (url: URL) => `${url.href.slice(0, -1)}`],
      ['no token on the stream', (url: URL) => `${url.origin}/events`],
    ])('refuses a request with %s before reading the store', async (_case, target) => {
      const reply = await get(target(address()));

      expect(reply.status).toBe(403);
      expect(reply.body).toBe('Forbidden.');
    });

    it.each([
      ['a rebound name', () => 'attacker.example'],
      ['localhost', () => `localhost:${address().port}`],
      ['the right address on another port', () => '127.0.0.1:1'],
    ])('refuses %s in the Host header, token and all', async (_case, hostHeader) => {
      const reply = await get(dashboard.url, { Host: hostHeader() });

      expect(reply.status).toBe(403);
    });

    it('takes nothing but a read', async () => {
      expect((await get(dashboard.url, {}, 'POST')).status).toBe(405);
    });

    it('serves nothing but the page and its stream', async () => {
      const reply = await get(`${address().origin}/other${address().search}`);

      expect(reply.status).toBe(404);
    });

    it('answers 500 for a store it cannot read, and ends a stream it could not fill', async () => {
      db.close();

      const page = await get(dashboard.url);
      const stream = await get(eventsUrl());

      expect(page.status).toBe(500);
      expect(page.body).toBe('The store could not be read.');
      expect(stream.status).toBe(200);
      expect(stream.body).toBe('');
    });

    it('serves the page under a CSP that admits only its own nonce and stream', async () => {
      const reply = await get(dashboard.url, { Host: host() });
      const csp = String(reply.headers['content-security-policy']);
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];

      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).not.toMatch(/https?:|\*|unsafe/);
      expect(reply.headers['referrer-policy']).toBe('no-referrer');
      expect(reply.body).toContain(`<script nonce="${nonce}">`);
      expect(reply.body).toContain(`<style nonce="${nonce}">`);
      // Nothing loaded from anywhere: no src, no stylesheet link.
      expect(reply.body).not.toMatch(/\ssrc=|<link/);
    });
  });

  describe('what it shows', () => {
    it("matches pup status's reading of the same store, section by section", async () => {
      vi.mocked(hasConductorWindow).mockReturnValue(true);
      seedMerge('s-pr', PR);
      appendEvent(db, 's-pr', 'gate_result', {
        from: 'merged',
        to: 'merged',
        report: {
          sessionId: 's-pr',
          passed: true,
          sandbox: 'none',
          stages: [{ stage: 'build', status: 'pass' }],
        },
      });
      appendEvent(db, 's-pr', 'merge', {
        branch: 'pup/s-pr',
        sha: 'e'.repeat(40),
        target: 'main',
        files: ['src/a.ts'],
        prUrl: PR,
      });
      seedSession('s-review', ['running', 'awaiting-review']);
      seedSession('s-blocked', ['running', 'blocked']);
      incrementRejectCount(db, 's-blocked');
      seedSession('s-asking', ['running']);
      appendEvent(db, 's-asking', 'steer', { kind: 'kickoff', by: 'conductor' });
      appendEvent(db, 's-asking', 'question', { text: 'rebase or merge?' });
      seedSession('s-done', ['running', 'killed']);
      insertTask(db, {
        id: 't-planned',
        projectId: projectId(repo),
        spec: JSON.stringify({ id: 't-planned', goal: 'planned work', scopeIn: ['src/**'] }),
        origin: 'human',
      });
      insertLedgerEntry(db, {
        projectId: projectId(repo),
        description: 'Oversize diff (812 lines) merged from session s-pr',
        files: ['src/a.ts'],
        reason: 'one feature',
        acceptedBy: 'alexis',
        reviewBy: '2000-01-01',
      });

      const page = (await get(dashboard.url)).body;
      const snapshot = buildDashboardSnapshot(db, repo, Date.now());
      const at = (text: string): number => page.indexOf(escapeHtml(text));

      // The inbox leads, in its own order, each line with its answer; the
      // review is the running conductor's to gate (decision 102).
      const needs = needsYou(snapshot);
      expect(needs.map((need) => need.kind)).toEqual(['question', 'blocked', 'pr-open']);
      for (const need of needs) {
        expect(page).toContain(escapeHtml(need.reason));
        expect(page).toContain(escapeHtml(need.answer));
      }
      expect(page).not.toContain(escapeHtml('pup review s-review'));
      expect(at('Needs you')).toBeLessThan(at('Conductor'));
      expect(at('Conductor')).toBeLessThan(at('Sessions'));
      // The conductor, attach command included: only the operator serves this page.
      expect(page).toContain(escapeHtml(snapshot.conductor.attachCommand));
      // Live sessions grouped by state; finished ones left to history, as `pup status` does.
      expect(at('Sessions')).toBeLessThan(page.indexOf('<h3 class="state-group">blocked'));
      expect(page.indexOf('<h3 class="state-group">blocked')).toBeLessThan(
        page.indexOf('<h3 class="state-group">running'),
      );
      expect(page.indexOf('<h3 class="state-group">running')).toBeLessThan(
        page.indexOf('<h3 class="state-group">awaiting-review'),
      );
      expect(page).not.toContain('<span class="sid">s-done</span>');
      expect(page).toContain('last steer: kickoff by conductor');
      // The open PR, as a link, with its CI review state and the debt it filed.
      expect(page).toContain(`<a href="${PR}" target="_blank" rel="noopener noreferrer">`);
      expect(page).toContain('CI review: re-gated after 1 fix round; last gate: passed at');
      expect(page).toMatch(/debt #1: Oversize diff \(812 lines\) merged from session s-pr/);
      // The planned task; the open ledger, overdue marked, is the Debt sheet's.
      expect(page).toContain('t-planned');
      expect(page).not.toContain('accepted by alexis');
      const debtSheet = (await get(`${dashboard.url}&sheet=debt`)).body;
      expect(debtSheet).toMatch(/#1<\/span><span class="state state-blocked">overdue/);
      expect(debtSheet).toContain('accepted by alexis, review by 2000-01-01');
    });

    it('puts the review in the inbox when no conductor runs to gate it', async () => {
      seedSession('s-review', ['running', 'awaiting-review']);

      const page = (await get(dashboard.url)).body;

      expect(page).toContain(escapeHtml('pup review s-review then pup merge s-review --pr'));
    });

    it('escapes a goal and a question holding markup and control characters', async () => {
      seedSession('s1', ['running'], '<img src=x onerror=alert(1)>\u001b[31mred\u009b2J');
      appendEvent(db, 's1', 'question', { text: '</script><script>alert(2)</script>' });

      const page = (await get(dashboard.url)).body;

      expect(page).not.toContain('<img');
      expect(page).not.toContain('<script>alert');
      // biome-ignore lint/suspicious/noControlCharactersInRegex: their absence is what is asserted
      expect(page).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
      expect(page).toContain('&lt;img src=x onerror=alert(1)&gt; [31mred 2J');
      expect(page).toContain('&lt;/script&gt;&lt;script&gt;alert(2)&lt;/script&gt;');
    });

    it('says what each running session is doing, as the hook events tell it', async () => {
      seedSession('s-asks', ['running']);
      seedHookEvent('s-asks', { hook_event_name: 'Notification', message: 'Allow\u001b Bash?' });
      seedSession('s-idle', ['running']);
      seedHookEvent('s-idle', { hook_event_name: 'Stop' });
      seedSession('s-quiet', ['running']);
      seedHookEvent('s-quiet', { hook_event_name: 'PostToolUse' }, STALLED_AFTER_MS + 60_000);
      seedSession('s-shell', ['running']);
      seedHookEvent('s-shell', [
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_response: { backgroundTaskId: 'b1' },
        },
        { hook_event_name: 'Stop' },
      ]);

      const page = (await get(dashboard.url)).body;

      expect(page).toContain('waiting on input (Allow Bash?)');
      expect(page).toContain('idle (turn ended, no done signal)');
      expect(page).toContain('working on a background shell');
      expect(page).toContain('stalled — see Needs you');
    });

    // Decision 92: the same words `pup status` prints for the route.
    it('says what each session runs on, its rung, and why it climbed there', async () => {
      seedSession('s-climbed', ['running']);
      recordSessionRoute(db, 's-climbed', {
        tier: 'critical',
        rung: 1,
        model: 'claude-opus-5-5',
        effort: 'xhigh',
        reason: 'turn-death',
        override: false,
      });
      seedSession('s-old', ['running']);

      const page = (await get(dashboard.url)).body;

      expect(page).toContain(
        '<div class="fact">claude-opus-5-5 xhigh, rung 2/2 after turn-death</div>',
      );
      expect(page.match(/rung \d\/\d/g)).toEqual(['rung 2/2']);
    });

    it('prints a placeholder for an id outside the minted shape, and pins no debt on it', async () => {
      seedSession('s 1', ['running']);
      insertLedgerEntry(db, {
        projectId: projectId(repo),
        description: 'Oversize diff (812 lines) merged from session s 1',
        files: [],
        reason: 'r',
        acceptedBy: 'alexis',
        reviewBy: '2999-01-01',
      });

      const page = (await get(dashboard.url)).body;

      expect(page).toContain('<span class="sid">(unminted session id)</span>');
      expect(page).not.toContain('debt #');
    });

    it('makes a link of a pull request url and of nothing else', async () => {
      seedMerge('s-evil', 'https://evil.example/x" onclick="alert(1)');
      seedMerge('s-js', 'javascript:alert(1)//github.com/o/r/pull/1');
      seedSession('s-ask', ['running']);
      appendEvent(db, 's-ask', 'question', { text: `see ${PR}` });

      const page = (await get(dashboard.url)).body;

      // The sheet links are the page's own, token and all; nothing else is a link.
      expect(page).not.toMatch(/<a href="(?!\?token=[\w-]+&amp;sheet=\w+")/);
      expect(page).not.toContain('evil.example');
      expect(page).toContain('(PR url outside the pull-request shape; inspect the store)');
      expect(page).toContain(`question: see ${PR}`);
    });
  });

  describe('the sheets', () => {
    const DAY = 86_400_000;
    const sheetUrl = (sheet: string): string => `${dashboard.url}&sheet=${sheet}`;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: their absence is what is asserted
    const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

    function writeBrief(text: string): void {
      mkdirSync(dirname(briefPath(repo)), { recursive: true });
      writeFileSync(briefPath(repo), text);
    }

    function fileDebt(
      description: string,
      files: string[],
      extra: Partial<{ reason: string; acceptedBy: string }> = {},
    ): number {
      return insertLedgerEntry(db, {
        projectId: projectId(repo),
        description,
        files,
        reason: extra.reason ?? 'r',
        acceptedBy: extra.acceptedBy ?? 'alexis',
        reviewBy: '2999-01-01',
      });
    }

    it('serves each sheet under a bar linking every sheet with the token, the current one marked', async () => {
      const token = address().searchParams.get('token');
      for (const [sheet, title] of [
        ['overview', 'Overview'],
        ['debt', 'Debt'],
      ]) {
        const reply = await get(sheetUrl(sheet as string));

        expect(reply.status).toBe(200);
        expect(reply.body).toContain(`<title>pup dashboard — ${title}</title>`);
        expect(reply.body).toContain(`<a href="?token=${token}&amp;sheet=overview"`);
        expect(reply.body).toContain(`<a href="?token=${token}&amp;sheet=debt"`);
        expect(reply.body).toContain(`sheet=${sheet}" aria-current="page">${title}</a>`);
      }
      expect((await get(dashboard.url)).body).toContain('aria-current="page">Overview</a>');
    });

    it('refuses a sheet it does not have, and a sheet without the token', async () => {
      expect((await get(sheetUrl('health'))).status).toBe(404);
      expect((await get(`${address().origin}/?sheet=debt`)).status).toBe(403);
    });

    it('renders every sheet on an empty store with a one-line hint for each chart', async () => {
      const overview = (await get(dashboard.url)).body;
      const debt = (await get(sheetUrl('debt'))).body;

      expect(overview).not.toContain('<svg');
      expect(overview).toContain('No goal yet — `pup brief edit` writes the Destination.');
      expect(overview).toContain('No task yet — `pup plan` adds one.');
      expect(overview).toContain('No merge in the last 8 weeks.');
      expect(overview).toContain('not measured — `pup init` measures it');
      expect(debt).not.toContain('<svg');
      expect(debt).toContain('No open debt — nothing to pay down.');
    });

    it("leads the Overview with the brief's Destination", async () => {
      writeBrief('## Destination\nShip the sheets.\nThen the actions.\n\n## Priorities\nsecret\n');

      const page = (await get(dashboard.url)).body;

      expect(page).toContain('<p class="brief">Ship the sheets.\nThen the actions.</p>');
      expect(page).not.toContain('secret');
    });

    it('shows the figures pup audit stored and pup debt lists, each with its week', async () => {
      const deadExports = (n: number) =>
        Array.from({ length: n }, (_, i) => ({ file: `src/f${i}.ts`, exportName: 'x' }));
      const capture = (capturedAt: string, dead: number, lines: number, ratio: number) => ({
        capturedAt,
        adapters: ['typescript'],
        stages: [],
        debt: {
          deadExports: deadExports(dead),
          duplicatedLines: lines,
          duplicationRule: DUPLICATION_RULE_ID,
          coverageRatio: ratio,
        },
      });
      const weekAgo = capture(new Date(Date.now() - 8 * DAY).toISOString(), 5, 120, 0.8);
      appendBaselineHistory(db, { projectId: projectId(repo), ...weekAgo });
      persistBaseline(db, projectId(repo), capture(new Date().toISOString(), 3, 130, 0.8234));
      fileDebt('Oversize diff (900 lines) merged from session s-1', ['src/a.ts']);
      const old = fileDebt('hand-filed', []);
      db.prepare("UPDATE ledger_entries SET created_at = '2026-01-01 00:00:00' WHERE id = ?").run(
        old,
      );

      const page = (await get(dashboard.url)).body;
      // `pup audit` prints each figure as the after side of its transition.
      const audited = (
        metric: 'deadExports' | 'duplicatedLines' | 'coverageRatio',
        value: number,
      ) =>
        /-> (\S+)/.exec(
          formatDebtTransition({ metric, before: value, after: value, delta: 'unchanged' }),
        )?.[1];
      const tile = (label: string): string =>
        new RegExp(
          `<div class="k">${label}</div><div class="v">([^<]*)</div><div class="d">([^<]*)</div>`,
        )
          .exec(page)
          ?.slice(1)
          .join(' | ') ?? '';

      expect(tile('open debt')).toBe(
        `${listLedgerEntries(db, projectId(repo)).length} | 1 filed in 7 days`,
      );
      expect(tile('coverage')).toBe(`${audited('coverageRatio', 0.8234)} | +2.3 pt in 7 days`);
      expect(tile('unused exports')).toBe(`${audited('deadExports', 3)} | -2 in 7 days`);
      expect(tile('duplicated lines')).toBe(`${audited('duplicatedLines', 130)} | +10 in 7 days`);
      expect(page).toContain('<figcaption>coverage by capture:');
      expect(page).toContain(`sheet=debt">Debt sheet: what to pay down next →</a>`);
    });

    it('counts tasks done, in flight and planned, and merges per week by first merge', async () => {
      seedMerge('s-a', PR);
      seedMerge('s-b', PR);
      appendEvent(db, 's-b', 'merge', {
        branch: 'pup/s-b',
        sha: 'e'.repeat(40),
        target: 'main',
        files: [],
        prUrl: PR,
      });
      db.prepare(
        "UPDATE events SET created_at = datetime('now', '-15 days') WHERE session_id = 's-b' AND type = 'merge' AND id = (SELECT MIN(id) FROM events WHERE session_id = 's-b' AND type = 'merge')",
      ).run();
      seedSession('s-run', ['running']);
      insertTask(db, {
        id: 't-planned',
        projectId: projectId(repo),
        spec: JSON.stringify({ id: 't-planned', goal: 'later', scopeIn: ['src/**'] }),
        origin: 'human',
      });

      const page = (await get(dashboard.url)).body;
      const merges =
        /<figcaption>Merges per week, week starting: ([^<]*)<\/figcaption>/.exec(page)?.[1] ?? '';

      expect(page).toContain('<figcaption>Tasks: done 2 · in flight 1 · planned 1</figcaption>');
      expect(merges.split(' · ').map((week) => Number(week.split(' ')[1]))).toEqual([
        0, 0, 0, 0, 0, 1, 0, 1,
      ]);
    });

    it('escapes every store string on both sheets, markup and control characters alike', async () => {
      const evil = '<img src=x onerror=alert(1)>\u001b[31m\u009b2J';
      writeBrief(`## Destination\n${evil}\n`);
      fileDebt(`Oversize diff ${evil}`, [`src/${evil}.ts`], { reason: evil, acceptedBy: evil });
      seedSession('s-evil', ['running'], evil);

      for (const page of [(await get(dashboard.url)).body, (await get(sheetUrl('debt'))).body]) {
        expect(page).not.toContain('<img');
        expect(page).not.toMatch(CONTROL);
        expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
      }
    });

    it('reads a brief heading that cannot match in linear time, on the poll the server answers from', async () => {
      // Thousands of blanks then a line separator backtracked cubically under the old heading match.
      writeBrief(`## Destination\nShip it.\n##${' '.repeat(7950)}\u2028\n`);

      const started = Date.now();
      const page = (await get(dashboard.url)).body;

      expect(Date.now() - started).toBeLessThan(1000);
      expect(page).toContain('<p class="brief">Ship it.');
    });

    it.each([
      ['a FIFO', (path: string) => execFileSync('mkfifo', [path])],
      ['a link to an endless device', (path: string) => symlinkSync('/dev/zero', path)],
    ])(
      'refuses a brief that is %s instead of blocking on it or reading it to the end',
      async (_case, plant) => {
        mkdirSync(dirname(briefPath(repo)), { recursive: true });
        plant(briefPath(repo));

        const page = (await get(dashboard.url)).body;

        expect(page).toContain('is not a plain file pup can read');
      },
    );

    it('replaces direction marks in the Destination and every ledger field', async () => {
      const spoof = 'src/evil\u202egnp.ts';
      writeBrief(`## Destination\nreach ${spoof}\n`);
      // Filed against a live session, so its row on the Overview shows the entry too.
      seedSession('s-live', ['running']);
      fileDebt(
        `Nested package ${spoof} changed with no build script, merged from session s-live`,
        [spoof],
        {
          reason: spoof,
          acceptedBy: spoof,
        },
      );

      const overview = (await get(dashboard.url)).body;
      for (const page of [overview, (await get(sheetUrl('debt'))).body]) {
        expect(page).not.toContain('\u202e');
      }
      expect(overview).toContain('debt #1: Nested package src/evil\ufffdgnp.ts changed');
      expect((await get(sheetUrl('debt'))).body).toContain('<code>src/evil\ufffdgnp.ts</code>');
    });

    it('treats a figure stored as Infinity as unmeasured, and draws no NaN', async () => {
      const debt = '{"deadExports":[],"duplicatedLines":1e999,"coverageRatio":1e999}';
      for (const day of ['01', '02']) {
        db.prepare(
          "INSERT INTO baseline_history (project_id, captured_at, stages, debt) VALUES (?, ?, '[]', ?)",
        ).run(projectId(repo), `2026-10-${day}T00:00:00.000Z`, debt);
      }
      db.prepare('UPDATE projects SET baseline = ? WHERE id = ?').run(
        `{"capturedAt":"2026-10-02T00:00:00.000Z","adapters":[],"stages":[],"debt":${debt}}`,
        projectId(repo),
      );

      const page = (await get(dashboard.url)).body;

      expect(page).not.toMatch(/NaN|Infinity/);
      expect(page).toContain('<div class="k">duplicated lines</div><div class="v">—</div>');
    });

    it('keeps streaming every sheet while another sheet cannot be rendered', async () => {
      const debt = await openStream(`${origin()}/events${address().search}&sheet=debt`);
      try {
        if (debt.frames.length === 0) await debt.next();
        // A reason stored as a BLOB, which the Debt sheet cannot read as text.
        const id = fileDebt('planted', []);
        db.prepare('UPDATE ledger_entries SET reason = ? WHERE id = ?').run(Buffer.from('x'), id);

        const overview = await openStream(eventsUrl());
        try {
          const first = overview.frames[0] ?? (await overview.next());
          expect(first).toContain('Nothing waits on you.');

          const arriving = overview.next();
          seedSession('s-new', ['running']);
          appendEvent(db, 's-new', 'question', { text: 'still live?' });

          expect(await arriving).toContain('question: still live?');
        } finally {
          overview.close();
        }
      } finally {
        debt.close();
      }
    });

    it("streams a sheet's own board, and a change to it within one poll", async () => {
      const stream = await openStream(`${origin()}/events${address().search}&sheet=debt`);
      try {
        const first = stream.frames[0] ?? (await stream.next());
        expect(first).toContain('No open debt — nothing to pay down.');

        const arriving = stream.next();
        fileDebt('Complexity rise (+9 decision points) merged from session s-1', ['src/b.ts']);

        expect(await arriving).toContain('<code>src/b.ts</code>');
      } finally {
        stream.close();
      }
    });
  });

  describe('the event stream', () => {
    it('sends the board on connect, and a store change within one poll', async () => {
      const stream = await openStream(eventsUrl());
      try {
        const first = stream.frames[0] ?? (await stream.next());
        expect(first).toContain('Nothing waits on you.');

        const arriving = stream.next();
        const changedAt = Date.now();
        seedSession('s-new', ['running']);
        appendEvent(db, 's-new', 'question', { text: 'which way?' });
        const frame = await arriving;

        expect(Date.now() - changedAt).toBeLessThanOrEqual(POLL_MS * 2);
        expect(frame).toContain('question: which way?');
      } finally {
        stream.close();
      }
    });

    it('sends a stream that opens on an unchanged store the board all the same', async () => {
      const first = await openStream(eventsUrl());
      try {
        if (first.frames.length === 0) await first.next();
        const second = await openStream(eventsUrl());
        try {
          const frame = second.frames[0] ?? (await second.next());

          expect(frame).toBe(first.frames[0]);
          expect(first.frames).toHaveLength(1);
        } finally {
          second.close();
        }
      } finally {
        first.close();
      }
    });

    it('reads nothing from the store while no stream is open', async () => {
      let reads = 0;
      const counted = new Proxy(db, {
        get(target, key) {
          if (key === 'prepare') reads += 1;
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const idle = await startWebDashboard(counted, repo, { pollMs: POLL_MS / 10 });
      try {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));

        expect(reads).toBe(0);
      } finally {
        await idle.close();
      }
    });

    it('stays quiet while the store does not change', async () => {
      const stream = await openStream(eventsUrl());
      try {
        if (stream.frames.length === 0) await stream.next();
        await new Promise((resolve) => setTimeout(resolve, POLL_MS * 3));

        expect(stream.frames).toHaveLength(1);
      } finally {
        stream.close();
      }
    });
  });
});
