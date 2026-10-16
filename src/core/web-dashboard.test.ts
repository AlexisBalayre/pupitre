import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { type IncomingHttpHeaders, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tmux boundary only: the store, the server and its socket all run for
// real, per docs/conventions/testing.md.
vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  hasConductorWindow: vi.fn(() => false),
}));

import { hasConductorWindow } from '../claude/session-runtime.service.js';
import { buildDashboardSnapshot, needsYou } from './dashboard.service.js';
import type { SessionState } from './db.client.js';
import { openStore } from './db.client.js';
import { insertLedgerEntry } from './ledger.repository.js';
import { projectId } from './paths.utils.js';
import {
  appendEvent,
  ensureProject,
  incrementRejectCount,
  insertSession,
  insertTask,
  transitionSession,
} from './session.repository.js';
import { startWebDashboard, type WebDashboard } from './web-dashboard.service.js';
import { escapeHtml } from './web-dashboard.template.js';

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
    vi.stubEnv('HOME', realpathSync(mkdtempSync(join(tmpdir(), 'pup-web-home-'))));
    db = openStore(':memory:');
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'pup-web-')));
    ensureProject(db, projectId(repo), repo);
    dashboard = await startWebDashboard(db, repo, { pollMs: POLL_MS });
  });

  afterEach(async () => {
    await dashboard.close();
    db.close();
    vi.unstubAllEnvs();
    vi.mocked(hasConductorWindow).mockReset();
    rmSync(repo, { recursive: true, force: true });
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

  const address = (): URL => new URL(dashboard.url);
  const host = (): string => address().host;

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

      // The inbox leads, in its own order, each line with its answer.
      const needs = needsYou(snapshot);
      expect(needs.map((need) => need.kind)).toEqual([
        'question',
        'blocked',
        'awaiting-review',
        'pr-open',
      ]);
      for (const need of needs) {
        expect(page).toContain(escapeHtml(need.reason));
        expect(page).toContain(escapeHtml(need.answer));
      }
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
      // The planned task and the open ledger, overdue marked.
      expect(page).toContain('t-planned');
      expect(page).toMatch(/#1<\/span><span class="state state-blocked">overdue/);
      expect(page).toContain('accepted by alexis, review by 2000-01-01');
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

    it('makes a link of a pull request url and of nothing else', async () => {
      seedMerge('s-evil', 'https://evil.example/x" onclick="alert(1)');
      seedMerge('s-js', 'javascript:alert(1)//github.com/o/r/pull/1');
      seedSession('s-ask', ['running']);
      appendEvent(db, 's-ask', 'question', { text: `see ${PR}` });

      const page = (await get(dashboard.url)).body;

      expect(page).not.toContain('<a ');
      expect(page).not.toContain('evil.example');
      expect(page).toContain('(PR url outside the pull-request shape; inspect the store)');
      expect(page).toContain(`question: see ${PR}`);
    });
  });

  describe('the event stream', () => {
    it('sends the board on connect, and a store change within one poll', async () => {
      const stream = await openStream(`${address().origin}/events${address().search}`);
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

    it('stays quiet while the store does not change', async () => {
      const stream = await openStream(`${address().origin}/events${address().search}`);
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
