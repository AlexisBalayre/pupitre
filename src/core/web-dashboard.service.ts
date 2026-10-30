import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Database } from 'better-sqlite3';

import { CHART_CSS } from './chart.utils.js';
import { PAGE_SHELL_CSS } from './page-shell.constants.js';
import { PAGE_THEME_CSS } from './page-theme.constants.js';
import { readDebtSheet, renderDebtSheet } from './web-dashboard-debt.service.js';
import { readHealthSheet, renderHealthSheet } from './web-dashboard-health.service.js';
import { readOverview, renderOverview } from './web-dashboard-overview.service.js';
import { escapeHtml, SHEETS, type SheetName } from './web-dashboard-sheet.utils.js';

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
 * The page is one of the sheets (decision 98), named by `?sheet=`, Overview
 * when it names none; each has its own stream. While a stream is open the
 * store is re-read every `pollMs` for the sheets streams are open on, and a
 * board that rendered differently from that sheet's last one goes to every
 * stream on the sheet whole; the browser never polls.
 */
export async function startWebDashboard(
  db: Database,
  repoPath: string,
  { pollMs = DASHBOARD_POLL_MS }: { pollMs?: number } = {},
): Promise<WebDashboard> {
  const token = Buffer.from(randomBytes(32).toString('base64url'));
  const streams = new Map<ServerResponse, SheetName>();
  const lastBody = new Map<SheetName, string>();
  // Relative, so it resolves against the page; the token rides along because
  // every request must carry it.
  const hrefOf = (sheet: SheetName): string => `?token=${token.toString()}&sheet=${sheet}`;

  const render = (sheet: SheetName): string => {
    const now = Date.now();
    switch (sheet) {
      case 'debt':
        return renderDebtSheet(readDebtSheet(db, repoPath, now));
      case 'health':
        return renderHealthSheet(readHealthSheet(db, repoPath));
      case 'overview':
        return renderOverview(readOverview(db, repoPath, now), hrefOf('debt'));
    }
  };
  const send = (stream: ServerResponse, body: string): void => {
    stream.write(`data: ${JSON.stringify(body)}\n\n`);
  };
  // A stream that just opened is sent the board even when nothing changed,
  // and when something did every stream on the sheet gets it, or the older
  // ones would wait for a change past the one the new stream already took.
  // One sheet at a time: a stream opening renders only its own sheet, so a
  // sheet the store cannot render right now never ends a stream on another.
  const publish = (sheet: SheetName, opened?: ServerResponse): void => {
    const body = render(sheet);
    if (body !== lastBody.get(sheet)) {
      lastBody.set(sheet, body);
      for (const [stream, on] of streams) if (on === sheet) send(stream, body);
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
    const sheet = sheetOf(url);
    if (sheet === undefined) return refuse(res, 404, 'Not found.');
    if (url.pathname === '/') {
      // Rendered before the head goes out, so a store that cannot be read is
      // still answered with a 500 rather than an empty 200.
      const body = render(sheet);
      const nonce = randomBytes(16).toString('base64');
      res.writeHead(200, {
        ...hardening(
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
            "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        ),
        'Content-Type': 'text/html; charset=utf-8',
      });
      res.end(renderDashboardPage(repoPath, sheet, body, nonce, hrefOf));
      return;
    }
    if (url.pathname === '/events') {
      res.writeHead(200, {
        ...hardening(REFUSAL_CSP),
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
      });
      streams.set(res, sheet);
      req.on('close', () => streams.delete(res));
      publish(sheet, res);
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
    for (const sheet of new Set(streams.values())) {
      try {
        publish(sheet);
      } catch {
        // This sheet is unreadable for one poll; the others still go out,
        // and the next poll reads it again.
      }
    }
  }, pollMs);

  return {
    url: `http://${LOOPBACK}:${port}/?token=${token.toString()}`,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(poll);
        for (const stream of streams.keys()) stream.end();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const SHEET_TITLES: Record<SheetName, string> = {
  overview: 'Overview',
  health: 'Health',
  debt: 'Debt',
};

/** The sheet a request names, Overview when it names none, undefined for a name no sheet has. */
function sheetOf(url: URL): SheetName | undefined {
  const named = url.searchParams.get('sheet');
  if (named === null) return 'overview';
  return SHEETS.find((sheet) => sheet === named);
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

/**
 * The page around a board. The script and the style carry the response's
 * nonce, the only source the CSP admits for either (decision 91); the script
 * only swaps in the board the stream sends, which the server rendered and
 * escaped, and reports whether the stream is up. The sheet bar is plain links,
 * so a sheet opens as its own page with its own stream (decision 98).
 */
function renderDashboardPage(
  repoPath: string,
  sheet: SheetName,
  body: string,
  nonce: string,
  hrefOf: (sheet: SheetName) => string,
): string {
  const bar = SHEETS.map(
    (name) =>
      `<a href="${escapeHtml(hrefOf(name))}"${name === sheet ? ' aria-current="page"' : ''}>${SHEET_TITLES[name]}</a>`,
  ).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>pup dashboard — ${SHEET_TITLES[sheet]}</title>
<style nonce="${nonce}">
${PAGE_THEME_CSS}
${PAGE_SHELL_CSS}
${CHART_CSS}
  body { overflow-wrap: anywhere; }
  nav.sheets { display: flex; gap: 4px; flex-wrap: wrap; padding: 8px 20px 0; border-bottom: 1px solid var(--grid); }
  nav.sheets a {
    padding: 6px 10px; color: var(--ink-2); text-decoration: none; font-size: 12px;
    border-bottom: 2px solid transparent;
  }
  nav.sheets a[aria-current="page"] { color: var(--ink); border-bottom-color: var(--debt-1); font-weight: 600; }
  .brief { white-space: pre-wrap; max-width: 65ch; }
  .lead { margin-bottom: 8px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
  .tile { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; }
  .tile .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  .tile .v { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .tile .d { color: var(--ink-2); font-size: 12px; }
  .tile figcaption { font-size: 11px; color: var(--muted); }
  .more { margin-top: 8px; font-size: 12px; }
  ol.paydown { padding-left: 20px; }
  details summary { cursor: pointer; color: var(--ink-2); }
  table.moves { border-collapse: collapse; width: 100%; font-size: 12px; }
  table.moves th { text-align: left; color: var(--muted); font-weight: 600; }
  table.moves th, table.moves td { padding: 6px 8px; border-bottom: 1px solid var(--grid); vertical-align: top; }
  table.moves td .hint { margin: 0; }
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
  @media (max-width: 480px) { header, main, nav.sheets { padding-left: 12px; padding-right: 12px; } }
</style>
</head>
<body>
<header><h1>pup dashboard</h1><span class="repo">${escapeHtml(repoPath)}</span><span class="live" id="live">connecting…</span></header>
<nav class="sheets">${bar}</nav>
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
