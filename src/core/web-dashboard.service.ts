import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Database } from 'better-sqlite3';

import { CHART_CSS } from './chart.utils.js';
import { PAGE_SHELL_CSS } from './page-shell.constants.js';
import { PAGE_THEME_CSS } from './page-theme.constants.js';
import { SESSION_ID_PATTERN } from './paths.constants.js';
import {
  ACTIONS,
  type ActionFields,
  type ActionName,
  CONFIRMED_ACTIONS,
  confirmationText,
  runAction,
} from './web-dashboard-actions.service.js';
import { readDebtSheet, renderDebtSheet } from './web-dashboard-debt.service.js';
import { readDecisionsSheet, renderDecisionsSheet } from './web-dashboard-decisions.service.js';
import { readHealthSheet, renderHealthSheet } from './web-dashboard-health.service.js';
import { readOverview, renderOverview } from './web-dashboard-overview.service.js';
import {
  readSessionView,
  renderSessionBoard,
  renderSessionHead,
} from './web-dashboard-session.service.js';
import { escapeHtml, hint, SHEETS, type SheetName } from './web-dashboard-sheet.utils.js';
import { readTasksSheet, renderTasksSheet } from './web-dashboard-tasks.service.js';

/** How often the server re-reads the store for the open streams (decision 91). */
const DASHBOARD_POLL_MS = 2_000;
const LOOPBACK = '127.0.0.1';
/** How long a confirmation the page asked for stays good (decision 91). */
const CONFIRM_TTL_MS = 5 * 60_000;
/** How long a page's action nonce stays good unused; a page idle longer reloads (decision 91). */
const PAGE_NONCE_TTL_MS = 30 * 60_000;
/** The most nonces held at once; past it the oldest go first (decision 91). */
const MAX_NONCES = 256;
/** The most an action's form may carry; a steer or a tell is far below it. */
const MAX_ACTION_BYTES = 64 * 1024;
/** The header the page's secret travels in; no other page can make a browser send it here. */
const SECRET_HEADER = 'x-pup-secret';
const REVOKED =
  'This url was opened a second time, so the page it opened first is cut off too. Run `pup dashboard` again for a new url.';

/** What a page shows: a sheet, or one session's view (decision 91). */
type View = { sheet: SheetName } | { session: string };

/**
 * What a nonce the page holds may do: the page's own runs any action once, and
 * one an irreversible action's first post minted runs that action alone, with
 * the very fields the operator was asked about, before it expires.
 */
type NonceGrant =
  | { kind: 'page'; mintedAt: number }
  | { kind: 'confirm'; action: ActionName; fields: string; mintedAt: number };

export interface WebDashboard {
  /** The page, token included: the one url that opens it, in one browser, once. */
  url: string;
  close: () => Promise<void>;
}

/**
 * `pup dashboard` (decision 91): one page on 127.0.0.1, on a random port,
 * behind a token minted for this run. The threat is the operator's own
 * browser: any page it has open can make it request a loopback url, and a
 * rebound DNS name can make that request same-origin. So every request must
 * name the loopback address as its Host, which a rebound name does not.
 * The page itself is a shell holding nothing from the store; what the store
 * says, and every action, is behind a secret the page sends in its
 * `X-Pup-Secret` header, which no other page can make the browser send
 * without a preflight this server never answers. The url's token is good for
 * one exchange: the first page served for it is handed the secret, which it
 * keeps in the tab's session storage (scoped to this origin, port and all,
 * as a cookie would not be), and takes the token out of the address bar. A
 * second load holding the token revokes the secret, cutting off whoever took
 * it first. The page loads nothing from elsewhere, its CSP admits only its own
 * nonce'd script and style and its own requests, and every store-read string
 * is escaped.
 *
 * The page is one of the sheets (decision 98), named by `?sheet=`, Overview
 * when it names none, or one session's view, named by `?session=`; each has
 * its own stream, read by `fetch` with the secret. While a stream is open the store is re-read every `pollMs`
 * for the views streams are open on, and a board that rendered differently
 * from that view's last one goes to every stream on it whole; the browser
 * never polls.
 *
 * The page acts through `POST /action`, secret and all, from its own origin,
 * with a nonce its stream hands it that one post uses up and whose answer
 * carries the next; one unused for `PAGE_NONCE_TTL_MS` lapses. An
 * irreversible action's first post only asks: it answers with a confirmation
 * nonce bound to that action and its fields, and only a second post carrying
 * it runs the action. Each action is the core call its CLI command makes.
 */
export async function startWebDashboard(
  db: Database,
  repoPath: string,
  { pollMs = DASHBOARD_POLL_MS }: { pollMs?: number } = {},
): Promise<WebDashboard> {
  const token = Buffer.from(randomBytes(32).toString('base64url'));
  // Minted when the token is spent, and dropped for good when it comes back.
  let secret: Buffer | undefined;
  let exchanged = false;
  const streams = new Map<ServerResponse, View>();
  const lastBody = new Map<string, string>();
  const nonces = new Map<string, NonceGrant>();
  const running = new Set<Promise<unknown>>();
  // Relative, so it resolves against the page; the secret, never the url,
  // carries the page's authority.
  const hrefOf = (sheet: SheetName): string => `?sheet=${sheet}`;
  const sessionHref = (sessionId: string): string => `?session=${encodeURIComponent(sessionId)}`;

  const render = (view: View): string => {
    const now = Date.now();
    if ('session' in view) {
      const read = readSessionView(db, repoPath, view.session, now);
      return read
        ? renderSessionHead(read) + renderSessionBoard(read)
        : hint(`No session ${view.session} in this store.`);
    }
    switch (view.sheet) {
      case 'debt':
        return renderDebtSheet(readDebtSheet(db, repoPath, now));
      case 'decisions':
        return renderDecisionsSheet(readDecisionsSheet(db, repoPath, now));
      case 'health':
        return renderHealthSheet(readHealthSheet(db, repoPath));
      case 'overview':
        return renderOverview(readOverview(db, repoPath, now), hrefOf('debt'), sessionHref);
      case 'tasks':
        return renderTasksSheet(readTasksSheet(db, repoPath, now));
    }
  };
  const send = (stream: ServerResponse, body: string): void => {
    stream.write(`data: ${JSON.stringify(body)}\n\n`);
  };
  // A stream that just opened is sent the board even when nothing changed,
  // and when something did every stream on the view gets it, or the older
  // ones would wait for a change past the one the new stream already took.
  // One view at a time: a stream opening renders only its own view, so a
  // view the store cannot render right now never ends a stream on another.
  const publish = (view: View, opened?: ServerResponse): void => {
    const key = viewKey(view);
    const body = render(view);
    if (body !== lastBody.get(key)) {
      lastBody.set(key, body);
      for (const [stream, on] of streams) if (viewKey(on) === key) send(stream, body);
    } else if (opened) {
      send(opened, body);
    }
  };

  // Every mint sweeps what lapsed and, past the cap, drops the oldest first,
  // so pages served and never used cannot grow the map without end.
  const mint = (grant: NonceGrant): string => {
    const now = Date.now();
    for (const [nonce, held] of nonces) if (lapsed(held, now)) nonces.delete(nonce);
    for (const nonce of nonces.keys()) {
      if (nonces.size < MAX_NONCES) break;
      nonces.delete(nonce);
    }
    const nonce = randomBytes(32).toString('base64url');
    nonces.set(nonce, grant);
    return nonce;
  };
  /** The action's answer, once it ran; held by `close` so the store outlives it. */
  const run = async (action: ActionName, fields: ActionFields): Promise<ActionAnswer> => {
    const job = runAction(db, repoPath, action, fields).then(
      (lines) => ({ ok: true, message: lines.join('\n') }),
      (error: unknown) => ({ ok: false, message: scrubbed(error) }),
    );
    running.add(job);
    try {
      return await job;
    } finally {
      running.delete(job);
    }
  };
  // The nonce is used up before anything else is read, so a post that fails
  // past here still cannot be replayed; every answer from here on carries the
  // next one, or the page could act no more.
  const act = async (form: URLSearchParams): Promise<ActionAnswer | undefined> => {
    const given = form.get('nonce') ?? '';
    const grant = nonces.get(given);
    if (grant === undefined) return undefined;
    nonces.delete(given);
    if (grant.kind === 'page' && lapsed(grant, Date.now())) return undefined;
    const action = ACTIONS.find((name) => name === form.get('action'));
    const fields: ActionFields = {};
    for (const [name, value] of form)
      if (name !== 'nonce' && name !== 'action') fields[name] = value;
    if (grant.kind === 'confirm') {
      if (
        action !== grant.action ||
        canonical(fields) !== grant.fields ||
        lapsed(grant, Date.now())
      ) {
        return {
          ok: false,
          message: 'That confirmation was for another action, or came too late; nothing was done.',
        };
      }
      return run(action, fields);
    }
    const next = mint({ kind: 'page', mintedAt: Date.now() });
    if (action === undefined)
      return { ok: false, message: 'No such action; nothing was done.', nonce: next };
    if (!CONFIRMED_ACTIONS.has(action)) return { ...(await run(action, fields)), nonce: next };
    // Asked only about what could run: fields the action would refuse, a
    // debt reason without its review-by, are refused here instead.
    let confirm: string;
    try {
      confirm = confirmationText(action, fields);
    } catch (error) {
      return { ok: false, message: scrubbed(error), nonce: next };
    }
    return {
      ok: true,
      message: '',
      confirm,
      confirmNonce: mint({
        kind: 'confirm',
        action,
        fields: canonical(fields),
        mintedAt: Date.now(),
      }),
      nonce: next,
    };
  };

  // Set once the socket is bound; no request is read before then.
  let port = 0;
  const holdsSecret = (req: IncomingMessage): boolean => {
    const given = req.headers[SECRET_HEADER];
    return secret !== undefined && typeof given === 'string' && matches(given, secret);
  };
  // Cut off means cut off: the streams already open go too, and with them
  // every nonce they were handed.
  const revoke = (): void => {
    secret = undefined;
    for (const stream of streams.keys()) stream.end();
    streams.clear();
    nonces.clear();
  };
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.host !== `${LOOPBACK}:${port}`) return refuse(res, 403, 'Forbidden.');
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}:${port}`);
    if (url.pathname === '/') return handlePage(req, res, url);
    if (!holdsSecret(req)) return refuse(res, 403, exchanged && !secret ? REVOKED : 'Forbidden.');
    if (url.pathname === '/action') return handleAction(req, res);
    if (req.method !== 'GET') return refuse(res, 405, 'Only /action takes a POST.');
    const view = viewOf(url);
    if (url.pathname !== '/events' || view === undefined) return refuse(res, 404, 'Not found.');
    res.writeHead(200, {
      ...hardening(REFUSAL_CSP),
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
    });
    streams.set(res, view);
    req.on('close', () => streams.delete(res));
    publish(view, res);
    // Minted only for the secret's holder, so no other page can fill the
    // map and push the operator's nonce out; each (re)connect hands a fresh one.
    res.write(
      `event: nonce\ndata: ${JSON.stringify(mint({ kind: 'page', mintedAt: Date.now() }))}\n\n`,
    );
  };

  /**
   * The page: a shell around the board its stream fills, holding nothing the
   * store says and never reading it. The load holding the url's token is handed the secret, once;
   * the token coming back revokes it.
   */
  const handlePage = (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (req.method !== 'GET') return refuse(res, 405, 'Only /action takes a POST.');
    const given = url.searchParams.get('token');
    if (given !== null) {
      if (!matches(given, token)) return refuse(res, 403, 'Forbidden.');
      if (exchanged) {
        revoke();
        return refuse(res, 403, REVOKED);
      }
    }
    // Named by the url alone: whether a session exists is the stream's to say.
    const view = viewOf(url);
    if (view === undefined) return refuse(res, 404, 'Not found.');
    // Spent only on a page that goes out, so a first load naming no view
    // leaves the url good for the next.
    if (given !== null) {
      exchanged = true;
      secret = Buffer.from(randomBytes(32).toString('base64url'));
    }
    const nonce = randomBytes(16).toString('base64');
    res.writeHead(200, {
      ...hardening(
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
          "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      ),
      'Content-Type': 'text/html; charset=utf-8',
    });
    res.end(
      renderDashboardPage(
        repoPath,
        {
          title: 'session' in view ? `Session ${view.session}` : SHEET_TITLES[view.sheet],
          current: 'sheet' in view ? view.sheet : undefined,
          nonce,
          secret: given === null ? undefined : secret?.toString(),
        },
        hrefOf,
      ),
    );
  };

  /**
   * A post to `/action`. Only a form post naming this origin is read: a
   * browser names the origin of every post its pages make, and a form is what
   * the page's script sends; one that says it came from another site, or does
   * not say, is refused. A wrong, used or lapsed nonce is refused before
   * anything runs.
   */
  const handleAction = (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') return refuse(res, 405, 'POST only.');
    const site = req.headers['sec-fetch-site'];
    if (
      req.headers.origin !== `http://${LOOPBACK}:${port}` ||
      (site !== undefined && site !== 'same-origin')
    ) {
      return refuse(res, 403, 'Forbidden.');
    }
    if (!String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded')) {
      return refuse(res, 415, 'A form post only.');
    }
    void readBody(req)
      .then(async (body) => {
        if (body === undefined) return refuse(res, 413, 'Too large.');
        const answer = await act(new URLSearchParams(body));
        if (answer === undefined) {
          return refuse(
            res,
            403,
            'This page key was used already, has lapsed or was never issued; nothing was done. Reload the page.',
          );
        }
        res.writeHead(200, {
          ...hardening(REFUSAL_CSP),
          'Content-Type': 'application/json; charset=utf-8',
        });
        res.end(JSON.stringify(answer));
      })
      .catch(() => {
        if (!res.headersSent) refuse(res, 500, 'The action could not be read.');
        else res.end();
      });
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
    const open = new Map([...streams.values()].map((view) => [viewKey(view), view]));
    for (const view of open.values()) {
      try {
        publish(view);
      } catch {
        // This view is unreadable for one poll; the others still go out,
        // and the next poll reads it again.
      }
    }
  }, pollMs);

  return {
    url: `http://${LOOPBACK}:${port}/?token=${token.toString()}`,
    // An action still running finishes first: the gate's own cleanup runs
    // under its lock, and the caller closes the store once this resolves.
    close: async () => {
      clearInterval(poll);
      for (const stream of streams.keys()) stream.end();
      await Promise.allSettled([...running]);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** What `/action` answers once its nonce was good: the result or refusal, and what the page holds next. */
interface ActionAnswer {
  ok: boolean;
  message: string;
  /** The page's next nonce; absent on a confirmation's answer, which used none of the page's. */
  nonce?: string;
  /** For an irreversible action: the question to ask, and the nonce that runs it once asked. */
  confirm?: string;
  confirmNonce?: string;
}

/** The fields a confirmation is bound to, in one order whatever order the form sent them in. */
function canonical(fields: ActionFields): string {
  return JSON.stringify(Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * A refusal's text for the page: core's message whole, as the CLI prints it,
 * with control characters gone but its lines kept (decision 68). The page sets
 * it as text, never as markup.
 */
function scrubbed(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  return message.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ');
}

/** The body of a post, or undefined past `MAX_ACTION_BYTES`. */
function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_ACTION_BYTES) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function viewKey(view: View): string {
  return 'session' in view ? `session:${view.session}` : `sheet:${view.sheet}`;
}

const SHEET_TITLES: Record<SheetName, string> = {
  overview: 'Overview',
  health: 'Health',
  debt: 'Debt',
  tasks: 'Tasks',
  decisions: 'Decisions',
};

/**
 * The view a request names: a session's for `?session=` holding a minted id,
 * else the sheet `?sheet=` names, Overview when it names none; undefined for
 * a name no view has.
 */
function viewOf(url: URL): View | undefined {
  const session = url.searchParams.get('session');
  if (session !== null) return SESSION_ID_PATTERN.test(session) ? { session } : undefined;
  const named = url.searchParams.get('sheet');
  if (named === null) return { sheet: 'overview' };
  const sheet = SHEETS.find((name) => name === named);
  return sheet && { sheet };
}

/** Whether a nonce is past its time: a confirmation's, or a page's left unused. */
function lapsed(grant: NonceGrant, now: number): boolean {
  return now - grant.mintedAt > (grant.kind === 'confirm' ? CONFIRM_TTL_MS : PAGE_NONCE_TTL_MS);
}

/** Compared in constant time, so a wrong guess learns nothing from how long it took. */
function matches(given: string, secret: Buffer): boolean {
  const candidate = Buffer.from(given);
  return candidate.length === secret.length && timingSafeEqual(candidate, secret);
}

const REFUSAL_CSP =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Headers every response carries. `no-referrer`, because the first url holds
 * the token and the page links out to pull requests; `no-store`, so the board is
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

/** What a page is made of beside the shell. */
interface PageParts {
  title: string;
  /** The sheet the bar marks as this page; none on a session's view. */
  current?: SheetName;
  /** The response's CSP nonce, for its one script and one style. */
  nonce: string;
  /** The secret, on the one page the url's token opened (decision 91). */
  secret?: string;
}

/**
 * The page around a board. The script and the style carry the response's
 * nonce, the only source the CSP admits for either (decision 91). The script
 * keeps the secret it was handed in the tab's session storage and takes the
 * spent token out of the address bar; reads the stream with the secret, and
 * swaps in the board it sends, which the server rendered and escaped, holding
 * it back while the operator types into a field on the board; reports whether
 * the stream is up; and posts each action form with the secret and the nonce
 * the stream handed it, asks before an irreversible one, and shows the answer
 * as text. The sheet bar is plain links, so a sheet opens as its own page with
 * its own stream, in the same tab, which keeps the secret (decision 98).
 */
function renderDashboardPage(
  repoPath: string,
  { title, current, nonce, secret }: PageParts,
  hrefOf: (sheet: SheetName) => string,
): string {
  const bar = SHEETS.map(
    (name) =>
      `<a href="${escapeHtml(hrefOf(name))}"${name === current ? ' aria-current="page"' : ''}>${SHEET_TITLES[name]}</a>`,
  ).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>pup dashboard — ${escapeHtml(title)}</title>
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
  form.act { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 6px; }
  form.act.wide input { flex: 1 1 160px; }
  form.act input[type="text"] { flex: 1 1 240px; }
  form.act input, form.act button, button[data-copy] {
    font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 4px;
    border: 1px solid var(--border); background: var(--surface); color: var(--ink);
  }
  form.act button, button[data-copy] { cursor: pointer; }
  form.act button.recommended { border-color: var(--debt-2); font-weight: 600; }
  #outcome { position: sticky; top: 0; z-index: 1; margin: 8px 20px 0; padding: 8px 12px; white-space: pre-wrap;
    border-radius: 6px; border: 1px solid var(--border); background: var(--surface); font-size: 12px; }
  #outcome.refused { border-left: 3px solid var(--debt-3); }
  #outcome.done { border-left: 3px solid var(--ink-2); }
  pre.pane {
    font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre; overflow-x: auto;
    background: var(--page); border: 1px solid var(--grid); border-radius: 6px; padding: 10px; margin: 0;
  }
  @media (max-width: 480px) { header, main, nav.sheets { padding-left: 12px; padding-right: 12px; } }
</style>
</head>
<body>
<header><h1>pup dashboard</h1><span class="repo">${escapeHtml(repoPath)}</span><span class="live" id="live">connecting…</span></header>
<nav class="sheets">${bar}</nav>
<div id="outcome" role="status" hidden></div>
<main id="board"></main>
<script nonce="${nonce}">
(() => {
  const board = document.getElementById('board');
  const live = document.getElementById('live');
  const outcome = document.getElementById('outcome');
  // Kept where only this origin, port and all, can read it, and gone with
  // the tab; the token that bought it leaves the address bar and history.
  const handed = ${JSON.stringify(secret ?? null)};
  if (handed !== null) sessionStorage.setItem('pup-dashboard-secret', handed);
  const here = new URL(location.href);
  if (here.searchParams.has('token')) {
    here.searchParams.delete('token');
    history.replaceState(null, '', here.pathname + here.search);
  }
  const secret = sessionStorage.getItem('pup-dashboard-secret');
  let key;
  let held;
  let busy = false;
  const say = (text, refused) => {
    outcome.textContent = text;
    outcome.className = refused ? 'refused' : 'done';
    outcome.hidden = false;
  };
  const typing = () => board.contains(document.activeElement) && document.activeElement.matches('input');
  const show = (next) => {
    if (typing()) held = next; else board.innerHTML = next;
  };
  board.addEventListener('focusout', () => setTimeout(() => {
    if (held !== undefined && !typing()) { board.innerHTML = held; held = undefined; }
  }));
  if (secret === null) {
    live.textContent = 'no key';
    return say('This tab holds no key: the url pup dashboard printed opens one tab, once, and links in that tab keep it.', true);
  }
  const listen = async () => {
    try {
      const res = await fetch('events' + location.search, { headers: { 'X-Pup-Secret': secret } });
      if (!res.ok) {
        live.textContent = 'refused';
        return say(await res.text(), true);
      }
      live.textContent = 'live';
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let end = buffer.indexOf('\\n\\n');
        while (end !== -1) {
          const lines = buffer.slice(0, end).split('\\n');
          buffer = buffer.slice(end + 2);
          const data = JSON.parse(lines.find((line) => line.startsWith('data: ')).slice(6));
          if (lines.includes('event: nonce')) key = data; else show(data);
          end = buffer.indexOf('\\n\\n');
        }
      }
    } catch {}
    live.textContent = 'reconnecting…';
    setTimeout(listen, 2000);
  };
  listen();
  const post = async (fields) => {
    const res = await fetch('action' + location.search, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Pup-Secret': secret },
      body: new URLSearchParams(fields),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  };
  document.addEventListener('submit', async (event) => {
    const form = event.target.closest('form[data-action]');
    if (!form) return;
    event.preventDefault();
    if (busy) return say('An action is still running; its answer comes first.', true);
    if (key === undefined) return say('Not connected yet; nothing was done.', true);
    const fields = Object.fromEntries(new FormData(form, event.submitter));
    fields.action = form.dataset.action;
    busy = true;
    say('Running ' + fields.action + '…', false);
    try {
      let answer = await post({ ...fields, nonce: key });
      if (answer.nonce) key = answer.nonce;
      if (answer.confirm !== undefined) {
        if (!window.confirm(answer.confirm)) return say('Not confirmed; nothing was done.', false);
        answer = await post({ ...fields, nonce: answer.confirmNonce });
      }
      say(answer.message, !answer.ok);
      if (answer.ok) form.reset();
    } catch (error) {
      say(error.message, true);
    } finally {
      busy = false;
    }
  });
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-copy]');
    if (!button) return;
    const text = document.getElementById(button.dataset.copy).textContent;
    navigator.clipboard.writeText(text).then(() => { button.textContent = 'Copied'; }, () => {});
  });
})();
</script>
</body>
</html>
`;
}
