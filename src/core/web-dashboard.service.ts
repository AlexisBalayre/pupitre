import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Database } from 'better-sqlite3';

import { sanitizeReason } from '../adapters/capability.utils.js';
import { buildDashboardSnapshot, needsYou, PR_URL, prFixRounds } from './dashboard.service.js';
import { listLedgerEntries } from './ledger.repository.js';
import { PAGE_SHELL_CSS } from './page-shell.constants.js';
import { PAGE_THEME_CSS } from './page-theme.constants.js';
import { projectId } from './paths.utils.js';
import type {
  DashboardNeed,
  DashboardSession,
  DashboardSnapshot,
} from './types/dashboard.types.js';

/** How often the server re-reads the store for the open streams (decision 91). */
const DASHBOARD_POLL_MS = 2_000;
const LOOPBACK = '127.0.0.1';

export interface WebDashboard {
  /** The page, token included: the one url that opens it. */
  url: string;
  close: () => Promise<void>;
}

/**
 * `pup dashboard` (decision 91): one read-only page on 127.0.0.1, on a random
 * port, behind a token minted for this run. The threat is the operator's own
 * browser: any page it has open can make it request a loopback url, and a
 * rebound DNS name can make that request same-origin. So every request must
 * carry the token, which no other origin can read, and name the loopback
 * address as its Host, which a rebound name does not; anything else is refused
 * before the store is read. The page loads nothing from elsewhere, its CSP
 * admits only its own nonce'd script and style and its own event stream, and
 * every store-read string on it is escaped.
 *
 * While a stream is open the store is re-read every `pollMs`, and a board that
 * rendered differently from the last one goes to every stream whole; the
 * browser never polls.
 */
export async function startWebDashboard(
  db: Database,
  repoPath: string,
  { pollMs = DASHBOARD_POLL_MS }: { pollMs?: number } = {},
): Promise<WebDashboard> {
  const token = Buffer.from(randomBytes(32).toString('base64url'));
  const streams = new Set<ServerResponse>();
  let lastBody: string | undefined;

  const render = (): string => renderDashboardBody(readView(db, repoPath));
  const send = (stream: ServerResponse, body: string): void => {
    stream.write(`data: ${JSON.stringify(body)}\n\n`);
  };
  // A stream that just opened is sent the board even when nothing changed,
  // and when something did every stream gets it, or the older ones would
  // wait for a change past the one the new stream already took.
  const publish = (opened?: ServerResponse): void => {
    const body = render();
    if (body !== lastBody) {
      lastBody = body;
      for (const stream of streams) send(stream, body);
    } else if (opened) {
      send(opened, body);
    }
  };

  // Set once the socket is bound; no request is read before then.
  let port = 0;
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.host !== `${LOOPBACK}:${port}`) return refuse(res, 403, 'Forbidden.');
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}:${port}`);
    if (!hasToken(url.searchParams.get('token'), token)) return refuse(res, 403, 'Forbidden.');
    if (req.method !== 'GET') return refuse(res, 405, 'Read-only.');
    if (url.pathname === '/') {
      // Rendered before the head goes out, so a store that cannot be read is
      // still answered with a 500 rather than an empty 200.
      const body = render();
      const nonce = randomBytes(16).toString('base64');
      res.writeHead(200, {
        ...hardening(
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
            "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        ),
        'Content-Type': 'text/html; charset=utf-8',
      });
      res.end(renderDashboardPage(repoPath, body, nonce));
      return;
    }
    if (url.pathname === '/events') {
      res.writeHead(200, {
        ...hardening(REFUSAL_CSP),
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
      });
      streams.add(res);
      req.on('close', () => streams.delete(res));
      publish(res);
      return;
    }
    refuse(res, 404, 'Not found.');
  };

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch {
      // A store that cannot be read right now (locked, mid-migration) is a
      // failed request, not a dead server; the stream retries on its own.
      if (!res.headersSent) refuse(res, 500, 'The store could not be read.');
      else res.end();
    }
  });
  port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => resolve((server.address() as AddressInfo).port));
  });

  const poll = setInterval(() => {
    if (streams.size === 0) return;
    try {
      publish();
    } catch {
      // Unreadable for one poll; the next one reads again.
    }
  }, pollMs);

  return {
    url: `http://${LOOPBACK}:${port}/?token=${token.toString()}`,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(poll);
        for (const stream of streams) stream.end();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The store's reading for one render: the snapshot, the inbox off it, and the ledger. */
function readView(db: Database, repoPath: string): WebDashboardView {
  const snapshot = buildDashboardSnapshot(db, repoPath, Date.now());
  const fixRounds = new Map(
    snapshot.sessions
      .filter((session) => session.openPr !== undefined && session.isMintedId)
      .map((session) => [session.id, prFixRounds(db, session.id)]),
  );
  return {
    snapshot,
    needs: needsYou(snapshot),
    // Read off the store like the snapshot's overdue entries, and scrubbed the
    // same way, so an id here matches the one the snapshot marks overdue.
    openDebt: listLedgerEntries(db, projectId(repoPath)).map((entry) => ({
      id: sanitizeReason(String(entry.id)),
      description: sanitizeReason(entry.description),
      acceptedBy: sanitizeReason(entry.accepted_by),
      reviewBy: sanitizeReason(entry.review_by),
    })),
    fixRounds,
  };
}

/** Compared in constant time, so a wrong guess learns nothing from how long it took. */
function hasToken(given: string | null, token: Buffer): boolean {
  if (given === null) return false;
  const candidate = Buffer.from(given);
  return candidate.length === token.length && timingSafeEqual(candidate, token);
}

const REFUSAL_CSP =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Headers every response carries. `no-referrer`, because the url holds the
 * token and the page links out to pull requests; `no-store`, so the board is
 * not kept on disk by the browser.
 */
function hardening(csp: string): Record<string, string> {
  return {
    'Content-Security-Policy': csp,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  };
}

function refuse(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { ...hardening(REFUSAL_CSP), 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

/** One open ledger entry as the page lists it, every field already through `sanitizeReason`. */
interface WebDebtEntry {
  id: string;
  description: string;
  acceptedBy: string;
  reviewBy: string;
}

/** What one render of the board reads: the snapshot `pup status` prints, and what it leaves to `pup debt`. */
interface WebDashboardView {
  snapshot: DashboardSnapshot;
  needs: DashboardNeed[];
  openDebt: WebDebtEntry[];
  /** Fix rounds re-gated per session with an open PR, keyed by session id (decision 86). */
  fixRounds: Map<string, number>;
}

/**
 * Every store-read string reaches the page through this (decision 91): the
 * snapshot already scrubbed what a terminal obeys (decision 29), and markup is
 * the browser's equivalent. Quotes too, since the PR url lands in an attribute.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escaped text, or a link when it is a pull request's url and nothing else (decisions 83, 91). */
function textOrPrLink(text: string): string {
  if (!PR_URL.test(text)) return `<code>${escapeHtml(text)}</code>`;
  // `noreferrer`: the page's own url carries the run token.
  return `<a href="${escapeHtml(text)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
}

/** The order the sessions' states are listed in: what has stopped first, finished work last. */
const STATE_ORDER = ['blocked', 'running', 'awaiting-review', 'queued', 'rejected'];
const UNMINTED_LABEL = '(unminted session id)';

/**
 * The board — everything inside `<main>` — as one string. The page carries it
 * first, and the event stream carries every later one whole, so the two are a
 * single render and a reader never sees a page the stream would draw otherwise.
 * Nothing in it is time-relative beyond what the snapshot holds, so an unchanged
 * store renders the same string and the stream stays quiet.
 */
function renderDashboardBody(view: WebDashboardView): string {
  return [
    needsSection(view.needs),
    conductorSection(view.snapshot),
    sessionsSection(view),
    pullRequestsSection(view),
    plannedSection(view.snapshot),
    debtSection(view),
  ].join('\n');
}

function section(title: string, body: string): string {
  return `<section><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

function hint(text: string): string {
  return `<p class="hint">${escapeHtml(text)}</p>`;
}

function needsSection(needs: DashboardNeed[]): string {
  if (needs.length === 0) return section('Needs you', hint('Nothing waits on you.'));
  const items = needs.map(
    (need) =>
      `<li class="need need-${escapeHtml(need.kind)}"><span class="sid">${escapeHtml(need.label)}</span> ` +
      `<span class="reason">${escapeHtml(need.reason)}</span>` +
      `<div class="answer">${textOrPrLink(need.answer)}</div></li>`,
  );
  return section('Needs you', `<ul class="rows">${items.join('')}</ul>`);
}

function conductorSection(snapshot: DashboardSnapshot): string {
  const { conductor } = snapshot;
  const body = conductor.running
    ? `<p>running <span class="hint">attach:</span> <code>${escapeHtml(conductor.attachCommand)}</code></p>`
    : hint('not running — `pup conductor start` starts it');
  return section('Conductor', body);
}

function sessionsSection(view: WebDashboardView): string {
  const live = view.snapshot.sessions.filter((s) => s.state !== 'merged' && s.state !== 'killed');
  if (live.length === 0) return section('Sessions', hint('Nothing running.'));
  const states = [
    ...STATE_ORDER.filter((state) => live.some((s) => s.state === state)),
    ...new Set(live.map((s) => s.state).filter((state) => !STATE_ORDER.includes(state))),
  ];
  const groups = states.map((state) => {
    const rows = live.filter((s) => s.state === state).map((s) => sessionRow(s, view.openDebt));
    return `<h3 class="state-group">${escapeHtml(state)} <span class="hint">${rows.length}</span></h3><ul class="rows">${rows.join('')}</ul>`;
  });
  return section('Sessions', groups.join(''));
}

function sessionRow(session: DashboardSession, openDebt: WebDebtEntry[]): string {
  const facts = [
    session.question === undefined ? '' : `question: ${session.question}`,
    activityText(session),
    session.rejectCount > 0 ? `${session.rejectCount} rejections` : '',
    session.contextTokens === undefined ? '' : `ctx ~${Math.round(session.contextTokens / 1000)}k`,
    steerText(session),
    gateText(session),
  ].filter(Boolean);
  return (
    `<li class="session"><div class="meta"><span class="sid">${escapeHtml(labelOf(session))}</span>` +
    `<span class="branch">${escapeHtml(session.branch)}</span></div>` +
    `<div class="goal">${escapeHtml(session.goal || '(no goal recorded)')}</div>` +
    facts.map((fact) => `<div class="fact">${escapeHtml(fact)}</div>`).join('') +
    debtOf(session, openDebt) +
    '</li>'
  );
}

function labelOf(session: DashboardSession): string {
  return session.isMintedId ? session.id : UNMINTED_LABEL;
}

function activityText(session: DashboardSession): string {
  if (session.stalledAgeMs !== undefined) return 'stalled — see Needs you';
  if (session.activity?.kind === 'awaiting-input') {
    const detail = sanitizeReason(session.activity.detail ?? '');
    return `waiting on input${detail ? ` (${detail})` : ''}`;
  }
  if (session.activity?.kind === 'idle') return 'idle (turn ended, no done signal)';
  return '';
}

function steerText(session: DashboardSession): string {
  const steer = session.lastSteer;
  if (!steer) return '';
  return `last steer: ${steer.kind ?? 'sent'}${steer.by ? ` by ${steer.by}` : ''} at ${steer.at}`;
}

function gateText(session: DashboardSession): string {
  const gate = session.lastGate;
  if (!gate) return '';
  const verdict = gate.passed
    ? 'passed'
    : `failed${gate.failedStage ? ` at ${gate.failedStage}` : ''}`;
  return `last gate: ${verdict} at ${gate.at}`;
}

/**
 * The open entries this session filed: every flag description the gate files
 * ends with ` session <id>` (decision 86). An id outside the minted shape is
 * matched against nothing, like the commands it gets none of.
 */
function debtOf(session: DashboardSession, openDebt: WebDebtEntry[]): string {
  if (!session.isMintedId) return '';
  const own = openDebt.filter((entry) => entry.description.endsWith(` session ${session.id}`));
  return own
    .map(
      (entry) =>
        `<div class="fact debt">debt #${escapeHtml(entry.id)}: ${escapeHtml(entry.description)}</div>`,
    )
    .join('');
}

function pullRequestsSection(view: WebDashboardView): string {
  const open = view.snapshot.sessions.filter((s) => s.openPr !== undefined);
  if (open.length === 0) return section('Open pull requests', hint('No PR waits to land.'));
  const rows = open.map((session) => {
    const url = session.openPr?.url;
    const link =
      url === undefined
        ? `<code>${escapeHtml('(PR url outside the pull-request shape; inspect the store)')}</code>`
        : textOrPrLink(url);
    return (
      `<li class="session"><div class="meta"><span class="sid">${escapeHtml(labelOf(session))}</span>${link}</div>` +
      `<div class="goal">${escapeHtml(session.goal || '(no goal recorded)')}</div>` +
      `<div class="fact">${escapeHtml(reviewState(session, view.fixRounds.get(session.id)))}</div>` +
      debtOf(session, view.openDebt) +
      '</li>'
    );
  });
  return section('Open pull requests', `<ul class="rows">${rows.join('')}</ul>`);
}

/**
 * The PR's CI review state as the store knows it: how many fix rounds were
 * re-gated, and the newest gate's verdict, which on a refused re-gate is what
 * says the PR still vouches for the earlier pin (decision 86). What CI itself
 * said is on the PR until `pup fix` reads the bot's threads (decision 90).
 */
function reviewState(session: DashboardSession, rounds: number | undefined): string {
  const regated =
    rounds === undefined
      ? 'fix rounds unknown'
      : rounds === 0
        ? 'gated once, no fix round re-gated yet'
        : `re-gated after ${rounds} fix ${rounds === 1 ? 'round' : 'rounds'}`;
  const gate = gateText(session);
  return `CI review: ${regated}${gate ? `; ${gate}` : ''}`;
}

function plannedSection(snapshot: DashboardSnapshot): string {
  if (snapshot.backlog.length === 0) return section('Planned', hint('Nothing planned.'));
  const rows = snapshot.backlog.map(
    (task) =>
      `<li class="session"><div class="meta"><span class="sid">${escapeHtml(task.id)}</span>` +
      `${task.origin === 'human' ? '' : `<span class="branch">from ${escapeHtml(task.origin)}</span>`}</div>` +
      `<div class="goal">${escapeHtml(task.goal || '(no goal recorded)')}</div></li>`,
  );
  return section('Planned', `<ul class="rows">${rows.join('')}</ul>`);
}

function debtSection(view: WebDashboardView): string {
  if (view.openDebt.length === 0) return section('Open debt', hint('No open debt.'));
  const overdue = new Set(view.snapshot.overdueDebt.map((entry) => entry.id));
  const rows = view.openDebt.map(
    (entry) =>
      `<li class="entry${overdue.has(entry.id) ? ' overdue' : ''}"><div class="meta"><span class="sid">#${escapeHtml(entry.id)}</span>` +
      `${overdue.has(entry.id) ? '<span class="state state-blocked">overdue</span>' : ''}</div>` +
      `<div class="desc">${escapeHtml(entry.description)}</div>` +
      `<div class="fact">accepted by ${escapeHtml(entry.acceptedBy)}, review by ${escapeHtml(entry.reviewBy)}</div></li>`,
  );
  return section('Open debt', `<ul class="rows">${rows.join('')}</ul>`);
}

/**
 * The page around a board. The script and the style carry the response's
 * nonce, the only source the CSP admits for either (decision 91); the script
 * only swaps in the board the stream sends, which the server rendered and
 * escaped, and reports whether the stream is up.
 */
function renderDashboardPage(repoPath: string, body: string, nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>pup dashboard</title>
<style nonce="${nonce}">
${PAGE_THEME_CSS}
${PAGE_SHELL_CSS}
  body { overflow-wrap: anywhere; }
  header .live { margin-left: auto; color: var(--muted); font-size: 12px; }
  ul.rows { list-style: none; padding: 0; }
  ul.rows > li {
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    padding: 10px 12px; margin-bottom: 8px;
  }
  h3.state-group { font-size: 12px; font-weight: 600; margin: 14px 0 6px; color: var(--ink-2); }
  .sid { font-weight: 600; }
  .need .reason { color: var(--ink-2); }
  .need.need-question, .need.need-blocked, .need.need-stalled { border-left: 3px solid var(--debt-2); }
  .answer, .goal, .fact, .desc { margin-top: 4px; }
  .fact { color: var(--ink-2); font-size: 12px; }
  .debt { color: var(--debt-3); }
  code {
    font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
    background: var(--page); border: 1px solid var(--grid); border-radius: 4px; padding: 0 4px;
  }
  a { color: var(--debt-2); }
  @media (max-width: 480px) { header, main { padding-left: 12px; padding-right: 12px; } }
</style>
</head>
<body>
<header><h1>pup dashboard</h1><span class="repo">${escapeHtml(repoPath)}</span><span class="live" id="live">connecting…</span></header>
<main id="board">
${body}
</main>
<script nonce="${nonce}">
(() => {
  const board = document.getElementById('board');
  const live = document.getElementById('live');
  const stream = new EventSource('events' + location.search);
  stream.onopen = () => { live.textContent = 'live'; };
  stream.onerror = () => { live.textContent = 'reconnecting…'; };
  stream.onmessage = (event) => { board.innerHTML = JSON.parse(event.data); };
})();
</script>
</body>
</html>
`;
}
