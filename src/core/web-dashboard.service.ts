import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Database } from 'better-sqlite3';

import { sanitizeReason } from '../adapters/capability.utils.js';
import { buildDashboardSnapshot, needsYou, prFixRounds } from './dashboard.service.js';
import { listLedgerEntries } from './ledger.repository.js';
import { projectId } from './paths.utils.js';
import {
  renderDashboardBody,
  renderDashboardPage,
  type WebDashboardView,
} from './web-dashboard.template.js';

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
      const nonce = randomBytes(16).toString('base64');
      res.writeHead(200, {
        ...hardening(
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
            "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        ),
        'Content-Type': 'text/html; charset=utf-8',
      });
      res.end(renderDashboardPage(repoPath, render(), nonce));
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
