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
  capturePane: vi.fn(() => ''),
  hasConductorWindow: vi.fn(() => false),
  conductorPane: vi.fn(() => undefined),
  readInputBoxLook: vi.fn(() => ({ state: 'empty', draft: '' })),
}));

import { tempDir } from '@test/helpers/temp-dir.mock.js';
import {
  capturePane,
  conductorPane,
  hasConductorWindow,
  readInputBoxLook,
  SessionPaneMissingError,
} from '../claude/session-runtime.service.js';
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
  getSession,
  incrementRejectCount,
  insertSession,
  insertTask,
  recordSessionRoute,
  transitionSession,
} from './session.repository.js';
import { STALLED_AFTER_MS } from './session-activity.constants.js';
import { startWebDashboard, type WebDashboard } from './web-dashboard.service.js';
import { ACTIONS } from './web-dashboard-actions.service.js';
import { escapeHtml } from './web-dashboard-sheet.utils.js';

const POLL_MS = 300;
const PR = 'https://github.com/o/r/pull/7';

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** The cookie the page's first load was handed; every request carries it unless it names `Cookie: ''`. */
let cookie: string | undefined;

/** The request's headers, the cookie included; one named as `''` is left out. */
function withCookie(headers: Record<string, string>): Record<string, string> {
  const all = { ...(cookie === undefined ? {} : { Cookie: cookie }), ...headers };
  return Object.fromEntries(Object.entries(all).filter(([, value]) => value !== ''));
}

const NO_COOKIE = { Cookie: '' };

/** The `name=value` of the cookie a reply sets. */
function cookieSet(reply: Reply): string {
  return String(reply.headers['set-cookie']?.[0]).split(';')[0] ?? '';
}

/** One request over the real socket, with the Host header the test names. */
function get(url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: withCookie(headers) }, (res) => {
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

/** A form post from the page's own origin over the real socket, answered as JSON when the server got that far. */
function post(
  url: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Reply & { json: () => Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: withCookie({
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: new URL(url).origin,
          ...headers,
        }),
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: () => JSON.parse(body) as Record<string, unknown>,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(new URLSearchParams(fields).toString());
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
    const req = request(url, { headers: withCookie({}) }, (res) => {
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
    cookie = undefined;
    dashboard = await startWebDashboard(db, repo, { pollMs: POLL_MS });
    cookie = cookieSet(await get(dashboard.url));
  });

  afterEach(async () => {
    await dashboard.close();
    db.close();
    vi.unstubAllEnvs();
    vi.mocked(hasConductorWindow).mockReset();
    vi.mocked(conductorPane).mockReturnValue(undefined);
    vi.mocked(readInputBoxLook).mockReturnValue({ state: 'empty', draft: '' });
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

    it("trades the url's token, once, for a cookie scripts cannot read, and takes it out of the address bar", async () => {
      const other = await startWebDashboard(db, repo, { pollMs: POLL_MS });
      const otherUrl = new URL(other.url);
      try {
        const opened = await get(`${other.url}&sheet=debt`, NO_COOKIE);
        const again = await get(other.url, NO_COOKIE);

        expect(opened.status).toBe(200);
        expect(opened.body).toContain('<title>pup dashboard — Debt</title>');
        expect(opened.headers['set-cookie']).toEqual([
          expect.stringMatching(
            new RegExp(
              `^pup-dashboard-${otherUrl.port}=[\\w-]{43}; HttpOnly; SameSite=Strict; Path=/$`,
            ),
          ),
        ]);
        expect(cookieSet(opened)).not.toContain(String(otherUrl.searchParams.get('token')));
        expect(opened.body).toContain(
          "history.replaceState(null, '', here.pathname + here.search);",
        );
        expect(again.status).toBe(403);
        expect(again.body).toBe(
          'This url was opened already: it lets one browser in, once. Run `pup dashboard` again for a new one.',
        );
        const page = await get(`${otherUrl.origin}/?sheet=debt`, { Cookie: cookieSet(opened) });
        expect(page.status).toBe(200);
        expect(page.headers['set-cookie']).toBeUndefined();
      } finally {
        await other.close();
      }
    });

    it('spends the token only on a page it served, so a first load it could not answer leaves it good', async () => {
      const other = await startWebDashboard(db, repo, { pollMs: POLL_MS });
      try {
        const missing = await get(`${other.url}&sheet=releases`, NO_COOKIE);
        const opened = await get(other.url, NO_COOKIE);

        expect(missing.status).toBe(404);
        expect(missing.headers['set-cookie']).toBeUndefined();
        expect(opened.status).toBe(200);
        expect(opened.headers['set-cookie']).toHaveLength(1);
      } finally {
        await other.close();
      }
    });

    it.each([
      ['no cookie', (url: URL) => `${url.origin}/`, () => NO_COOKIE],
      ['the spent token alone', (url: URL) => url.href, () => NO_COOKIE],
      ['a wrong token', (url: URL) => `${url.origin}/?token=${'A'.repeat(43)}`, () => NO_COOKIE],
      ['a token one character short', (url: URL) => url.href.slice(0, -1), () => NO_COOKIE],
      [
        'no cookie on the stream',
        (url: URL) => url.href.replace('/?', '/events?'),
        () => NO_COOKIE,
      ],
      [
        'a wrong cookie',
        (url: URL) => `${url.origin}/`,
        () => ({ Cookie: `pup-dashboard-${address().port}=${'A'.repeat(43)}` }),
      ],
      [
        "another port's cookie name",
        (url: URL) => `${url.origin}/`,
        () => ({ Cookie: String(cookie).replace(/-\d+=/, '-1=') }),
      ],
    ])('refuses a request with %s before reading the store', async (_case, target, headers) => {
      const reply = await get(target(address()), headers());

      expect(reply.status).toBe(403);
    });

    it.each([
      ['a rebound name', () => 'attacker.example'],
      ['localhost', () => `localhost:${address().port}`],
      ['the right address on another port', () => '127.0.0.1:1'],
    ])('refuses %s in the Host header, token and all', async (_case, hostHeader) => {
      const reply = await get(dashboard.url, { Host: hostHeader() });

      expect(reply.status).toBe(403);
    });

    it('takes a post at /action only, and nothing but a post there', async () => {
      expect((await get(dashboard.url, {}, 'POST')).status).toBe(405);
      expect((await get(`${origin()}/action${address().search}`)).status).toBe(405);
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

    // Decision 168: the look `pup conductor tell` refuses on, held past ten minutes.
    it('lists a conductor nothing reaches under Needs you, with the attach line', async () => {
      vi.mocked(hasConductorWindow).mockReturnValue(true);
      vi.mocked(conductorPane).mockReturnValue({ sessionId: 'c', paneId: '%3', socket: 'sock' });
      vi.mocked(readInputBoxLook).mockReturnValue({ state: 'holds', draft: 'draft' });
      // The first look starts the clock; the page's own look, a quarter-hour on, finds it held.
      buildDashboardSnapshot(db, repo, Date.now() - 15 * 60_000);

      const page = (await get(dashboard.url)).body;
      const snapshot = buildDashboardSnapshot(db, repo, Date.now());

      const line = page.slice(page.indexOf('need-conductor'));
      expect(page.indexOf('need-conductor')).toBeGreaterThan(page.indexOf('Needs you'));
      expect(line.slice(0, line.indexOf('</li>'))).toContain(
        escapeHtml(snapshot.conductor.attachCommand),
      );
      expect(line).toContain('blocked: unsent draft (15m)');
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

      // The sheet and session-view links are the page's own, with no token:
      // the cookie carries the page; nothing else is a link.
      expect(page).not.toMatch(/<a href="(?!\?(?:sheet=\w+|session=[\w-]+)")/);
      expect(page).not.toContain(String(address().searchParams.get('token')));
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

    it('serves each sheet under a bar linking every sheet, the current one marked', async () => {
      for (const [sheet, title] of [
        ['overview', 'Overview'],
        ['health', 'Health'],
        ['debt', 'Debt'],
        ['tasks', 'Tasks'],
        ['decisions', 'Decisions'],
      ]) {
        const reply = await get(sheetUrl(sheet as string));

        expect(reply.status).toBe(200);
        expect(reply.body).toContain(`<title>pup dashboard — ${title}</title>`);
        expect(reply.body).toContain('<a href="?sheet=overview"');
        expect(reply.body).toContain('<a href="?sheet=health"');
        expect(reply.body).toContain('<a href="?sheet=debt"');
        expect(reply.body).toContain('<a href="?sheet=tasks"');
        expect(reply.body).toContain('<a href="?sheet=decisions"');
        expect(reply.body).toContain(`sheet=${sheet}" aria-current="page">${title}</a>`);
      }
      expect((await get(dashboard.url)).body).toContain('aria-current="page">Overview</a>');
    });

    it('refuses a sheet it does not have, and a sheet without the cookie', async () => {
      expect((await get(sheetUrl('releases'))).status).toBe(404);
      expect((await get(`${address().origin}/?sheet=debt`, NO_COOKIE)).status).toBe(403);
    });

    it('renders every sheet on an empty store with a one-line hint for each chart', async () => {
      const overview = (await get(dashboard.url)).body;
      const debt = (await get(sheetUrl('debt'))).body;
      const health = (await get(sheetUrl('health'))).body;
      const tasks = (await get(sheetUrl('tasks'))).body;
      const decisions = (await get(sheetUrl('decisions'))).body;

      expect(overview).not.toContain('<svg');
      expect(overview).toContain('No goal yet — `pup brief edit` writes the Destination.');
      expect(overview).toContain('No task yet — `pup plan` adds one.');
      expect(overview).toContain('No merge in the last 8 weeks.');
      expect(overview).toContain('not measured — `pup init` measures it');
      expect(debt).not.toContain('<svg');
      expect(debt).toContain('No open debt — nothing to pay down.');
      expect(health).not.toContain('<svg');
      expect(health).toContain('No snapshot yet — `pup init` captures the first.');
      expect(tasks).not.toContain('<svg');
      expect(tasks).toContain('No gate run in the last 8 weeks.');
      expect(tasks).toContain('Nothing planned — `pup plan` adds a task.');
      expect(tasks).toContain('No session has reached a PR yet.');
      expect(decisions).not.toContain('<svg');
      expect(decisions).toContain('No decision recorded yet — each merge records one.');
      expect(decisions).toContain('No source under src/ to map.');
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
  describe('what it does', () => {
    const actionUrl = (search = address().search): string => `${origin()}/action${search}`;

    /** The action nonce a freshly served page holds. */
    async function pageKey(url = dashboard.url): Promise<string> {
      const key = /let key = "([^"]+)";/.exec((await get(url)).body)?.[1];
      if (key === undefined) throw new Error('the page holds no action nonce');
      return key;
    }

    function seedDebt(): number {
      insertLedgerEntry(db, {
        projectId: projectId(repo),
        description: 'Oversize diff (812 lines) merged from session s-pr',
        files: ['src/a.ts'],
        reason: 'one feature',
        acceptedBy: 'human',
        reviewBy: 'next sprint',
      });
      return listLedgerEntries(db, projectId(repo))[0]?.id ?? 0;
    }

    const isOpen = (id: number): boolean =>
      listLedgerEntries(db, projectId(repo)).some((entry) => entry.id === id);

    it.each([
      ['no cookie', () => `${origin()}/action`, (): Record<string, string> => NO_COOKIE],
      ['the spent token instead of the cookie', () => actionUrl(), () => NO_COOKIE],
      [
        'a wrong cookie',
        () => actionUrl(),
        () => ({ Cookie: `pup-dashboard-${address().port}=${'A'.repeat(43)}` }),
      ],
      ['no Origin', () => actionUrl(), () => ({ Origin: '' })],
      [
        'a cross-site Sec-Fetch-Site',
        () => actionUrl(),
        () => ({ 'Sec-Fetch-Site': 'cross-site' }),
      ],
      ['a same-site Sec-Fetch-Site', () => actionUrl(), () => ({ 'Sec-Fetch-Site': 'same-site' })],
    ])('refuses a post with %s, and changes nothing', async (_case, url, headers) => {
      const id = seedDebt();
      const key = await pageKey();

      const reply = await post(
        url(),
        { action: 'debt-close', id: String(id), nonce: key },
        headers(),
      );

      expect(reply.status).toBe(403);
      expect(isOpen(id)).toBe(true);
      // The key was never read, so the page still holds a good one.
      expect(
        (await post(actionUrl(), { action: 'debt-close', id: String(id), nonce: key })).status,
      ).toBe(200);
    });

    it('refuses a wrong nonce, a reused one and a used confirmation, and changes nothing', async () => {
      const id = seedDebt();
      const key = await pageKey();
      const fields = { action: 'debt-close', id: String(id) };

      const wrong = await post(actionUrl(), { ...fields, nonce: 'A'.repeat(43) });
      const asked = (await post(actionUrl(), { ...fields, nonce: key })).json();
      const reused = await post(actionUrl(), { ...fields, nonce: key });

      expect(wrong.status).toBe(403);
      expect(wrong.body).toContain('nothing was done');
      expect(reused.status).toBe(403);
      expect(isOpen(id)).toBe(true);

      const done = (
        await post(actionUrl(), { ...fields, nonce: String(asked.confirmNonce) })
      ).json();
      const again = await post(actionUrl(), { ...fields, nonce: String(asked.confirmNonce) });

      expect(done).toEqual({ ok: true, message: `Closed ledger entry #${id}.` });
      expect(again.status).toBe(403);
    });

    it('refuses a post naming another origin, and one that is not a form', async () => {
      const id = seedDebt();
      const key = await pageKey();

      const foreign = await post(
        actionUrl(),
        { action: 'debt-close', id: String(id), nonce: key },
        { Origin: 'http://attacker.example' },
      );
      const json = await post(actionUrl(), { nonce: key }, { 'Content-Type': 'application/json' });

      expect(foreign.status).toBe(403);
      expect(json.status).toBe(415);
      expect(isOpen(id)).toBe(true);
    });

    it.each([
      ['kill', { session: 's-live' }, 'Kill session s-live?'],
      ['merge', { session: 's-live' }, 'Gate session s-live and open its pull request?'],
      ['land', { session: 's-live' }, 'Land session s-live?'],
      ['debt-close', { id: '1' }, 'Close ledger entry #1?'],
    ])(
      'asks before %s runs, and runs nothing on the first post',
      async (action, fields, question) => {
        seedSession('s-live', ['running']);
        const id = seedDebt();

        const answer = (
          await post(actionUrl(), { action, ...fields, nonce: await pageKey() })
        ).json();

        expect(answer.ok).toBe(true);
        expect(String(answer.confirm)).toContain(question);
        expect(answer.confirmNonce).toEqual(expect.any(String));
        expect(answer.nonce).toEqual(expect.any(String));
        expect(getSession(db, 's-live')?.state).toBe('running');
        expect(isOpen(id)).toBe(true);
      },
    );

    it('refuses debt fields `pup merge` refuses before asking, and keeps the page able to act', async () => {
      seedSession('s-live', ['running']);

      const answer = (
        await post(actionUrl(), {
          action: 'merge',
          session: 's-live',
          reason: 'one feature',
          nonce: await pageKey(),
        })
      ).json();

      expect(answer).toEqual({
        ok: false,
        message: 'A debt reason and a review-by go together; nothing was gated.',
        nonce: expect.any(String),
      });
    });

    it('runs a confirmation for the action and fields it was minted for and no others', async () => {
      const id = seedDebt();
      const fields = { action: 'debt-close', id: String(id) };
      const asked = (await post(actionUrl(), { ...fields, nonce: await pageKey() })).json();
      const askedAgain = (
        await post(actionUrl(), { ...fields, nonce: String(asked.nonce) })
      ).json();

      const other = (
        await post(actionUrl(), { ...fields, id: '999', nonce: String(asked.confirmNonce) })
      ).json();
      const kill = (
        await post(actionUrl(), {
          action: 'kill',
          session: 's-x',
          nonce: String(askedAgain.confirmNonce),
        })
      ).json();
      // Used up by the refusal: the right fields cannot ride it afterwards.
      const late = await post(actionUrl(), { ...fields, nonce: String(asked.confirmNonce) });

      const refusal = {
        ok: false,
        message: 'That confirmation was for another action, or came too late; nothing was done.',
      };
      expect(other).toEqual(refusal);
      expect(kill).toEqual(refusal);
      expect(late.status).toBe(403);
      expect(isOpen(id)).toBe(true);
    });

    it('takes a post the browser says is same-origin', async () => {
      const id = seedDebt();

      const reply = await post(
        actionUrl(),
        { action: 'debt-close', id: String(id), nonce: await pageKey() },
        { 'Sec-Fetch-Site': 'same-origin' },
      );

      expect(reply.status).toBe(200);
      expect(reply.json().confirm).toEqual(expect.any(String));
    });

    it('refuses a page nonce left unused for 30 minutes, and changes nothing', async () => {
      const id = seedDebt();
      const key = await pageKey();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + 30 * 60_000 + 1);
      try {
        const reply = await post(actionUrl(), { action: 'debt-close', id: String(id), nonce: key });

        expect(reply.status).toBe(403);
        expect(reply.body).toContain('has lapsed');
        expect(isOpen(id)).toBe(true);
      } finally {
        vi.mocked(Date.now).mockRestore();
      }
    });

    it('holds at most 256 nonces, dropping the oldest first', async () => {
      const id = seedDebt();
      const oldest = await pageKey();
      const second = await pageKey();
      for (let served = 0; served < 255; served++) await pageKey();

      const dropped = await post(actionUrl(), {
        action: 'debt-close',
        id: String(id),
        nonce: oldest,
      });
      const kept = await post(actionUrl(), { action: 'debt-close', id: String(id), nonce: second });

      expect(dropped.status).toBe(403);
      expect(kept.status).toBe(200);
    });

    it("shows core's refusal as the answer, and hands the page its next nonce", async () => {
      const first = (
        await post(actionUrl(), {
          action: 'steer',
          session: 's-gone',
          message: 'hi',
          nonce: await pageKey(),
        })
      ).json();
      const second = (
        await post(actionUrl(), {
          action: 'answer',
          target: 's-gone',
          reply: '1',
          nonce: String(first.nonce),
        })
      ).json();

      expect(first.ok).toBe(false);
      expect(String(first.message)).toContain('s-gone');
      expect(second.ok).toBe(false);
      expect(String(second.message)).toContain('s-gone');
      expect(second.nonce).toEqual(expect.any(String));
    });

    it("shows the ledger's refusal of an entry that is not open, once confirmed", async () => {
      const id = seedDebt();
      const asked = (
        await post(actionUrl(), { action: 'debt-close', id: String(id), nonce: await pageKey() })
      ).json();
      const missing = (
        await post(actionUrl(), { action: 'debt-close', id: '999', nonce: String(asked.nonce) })
      ).json();
      const missingDone = (
        await post(actionUrl(), {
          action: 'debt-close',
          id: '999',
          nonce: String(missing.confirmNonce),
        })
      ).json();

      expect(missingDone).toEqual({ ok: false, message: 'No open ledger entry #999.' });
      expect(isOpen(id)).toBe(true);
    });

    it('puts the actions on the sheets: answers, a tell, launches and closes', async () => {
      vi.mocked(hasConductorWindow).mockReturnValue(true);
      seedSession('s-asking', ['running']);
      appendEvent(db, 's-asking', 'question', {
        text: 'rebase or merge?',
        options: ['rebase', 'merge'],
        recommended: 1,
      });
      insertTask(db, {
        id: 't-planned',
        projectId: projectId(repo),
        spec: JSON.stringify({ id: 't-planned', goal: 'planned work', scopeIn: ['src/**'] }),
        origin: 'human',
      });
      const id = seedDebt();

      const overview = (await get(dashboard.url)).body;
      const debt = (await get(`${dashboard.url}&sheet=debt`)).body;
      const tasks = (await get(`${dashboard.url}&sheet=tasks`)).body;

      expect(overview).toContain(
        'name="reply" value="1" class="recommended">1. rebase (recommended)',
      );
      expect(overview).toContain('<form class="act" data-action="tell">');
      expect(overview).toContain(
        '<form class="act" data-action="launch"><input type="hidden" name="task" value="t-planned">',
      );
      expect(overview).toContain(`session=s-asking">open</a>`);
      expect(debt).toContain(
        `<form class="act" data-action="debt-close"><input type="hidden" name="id" value="${id}">`,
      );
      expect(tasks).toContain(
        'data-action="launch"><input type="hidden" name="task" value="t-planned">',
      );
    });
  });

  describe('the session view', () => {
    const viewUrl = (sessionId: string): string => `${dashboard.url}&session=${sessionId}`;
    const viewEvents = (sessionId: string): string =>
      `${origin()}/events${address().search}&session=${sessionId}`;

    function seedWindow(sessionId: string, path: SessionState[]): void {
      seedSession(sessionId, path);
      db.prepare('UPDATE sessions SET tmux_target = ? WHERE id = ?').run('%5', sessionId);
    }

    afterEach(() => {
      vi.mocked(capturePane).mockReset();
    });

    it("shows the worker's pane escaped, with a copyable attach line and its actions", async () => {
      seedWindow('s-1', ['running']);
      vi.mocked(capturePane).mockReturnValue(
        '> <script>alert(1)</script>\n\u001b[31mred\u202e & done\n',
      );

      const page = (await get(viewUrl('s-1'))).body;

      expect(capturePane).toHaveBeenCalledWith({ sessionId: 's-1', paneId: '%5' });
      expect(page).toContain(
        '<pre class="pane">&gt; &lt;script&gt;alert(1)&lt;/script&gt;\n\uFFFD[31mred\uFFFD &amp; done\n</pre>',
      );
      expect(page).not.toContain('<script>alert');
      expect(page).not.toContain('\u001b');
      expect(page).not.toContain('\u202e');
      expect(page).toContain('<code id="attach">pup attach s-1</code>');
      expect(page).toContain('<button type="button" data-copy="attach">Copy</button>');
      for (const action of ['steer', 'merge', 'kill']) {
        expect(page).toContain(`data-action="${action}"`);
      }
      expect(page).toContain('name="reason"');
      expect(page).toContain('name="reviewBy"');
      expect(page).toContain('name="approver"');
    });

    it('refreshes the pane over its stream as the window changes', async () => {
      seedWindow('s-1', ['running']);
      vi.mocked(capturePane).mockReturnValue('first <b>screen</b>');
      const stream = await openStream(viewEvents('s-1'));
      try {
        const first = stream.frames[0] ?? (await stream.next());
        expect(first).toContain('first &lt;b&gt;screen&lt;/b&gt;');

        const arriving = stream.next();
        vi.mocked(capturePane).mockReturnValue('second screen');
        const frame = await arriving;

        expect(frame).toContain('<pre class="pane">second screen</pre>');
        expect(frame).not.toContain('first');
      } finally {
        stream.close();
      }
    });

    it('says the window is gone rather than failing, when tmux has no pane', async () => {
      seedWindow('s-1', ['running']);
      vi.mocked(capturePane).mockImplementation(() => {
        throw new SessionPaneMissingError('s-1', '%5', 'gone');
      });

      const page = await get(viewUrl('s-1'));

      expect(page.status).toBe(200);
      expect(page.body).toContain('No live window: its pane is gone or was never recorded.');
    });

    it('links a merged session to its PR on GitHub and offers no button that merges there', async () => {
      seedMerge('s-pr', PR);

      const page = (await get(viewUrl('s-pr'))).body;
      const forms = [...page.matchAll(/<form [^>]*data-action="([^"]+)"/g)].map((m) => m[1]);

      expect(page).toContain(`<a href="${PR}" target="_blank" rel="noopener noreferrer">`);
      expect(forms.sort()).toEqual(['fix', 'land', 'merge']);
      expect(forms.every((action) => (ACTIONS as readonly string[]).includes(action ?? ''))).toBe(
        true,
      );
      // The one merge is the gate's `--pr` re-gate, which opens or updates
      // the PR; the PR itself is merged on GitHub, by its link.
      expect(page).toContain('Re-gate the PR');
      expect(page).not.toMatch(/<form[^>]*github/i);
    });

    it.each([
      ['an id the store does not hold', 's-none'],
      ['an id outside the minted shape', 's%20x'],
    ])('answers 404 for %s', async (_case, sessionId) => {
      expect((await get(viewUrl(sessionId))).status).toBe(404);
    });
  });
});
