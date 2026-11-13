import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Database } from 'better-sqlite3';

import { hardening, REFUSAL_CSP, refuse } from './web-dashboard-access.service.js';
import {
  ACTIONS,
  type ActionFields,
  type ActionName,
  type ConfirmedAction,
  confirmationText,
  isConfirmed,
  runAction,
} from './web-dashboard-actions.service.js';

/** How long a confirmation the page asked for stays good (decision 91). */
const CONFIRM_TTL_MS = 5 * 60_000;
/** How long a page's action nonce stays good unused; a page idle longer reloads (decision 91). */
const PAGE_NONCE_TTL_MS = 30 * 60_000;
/** The most nonces held at once; past it the oldest go first (decision 91). */
const MAX_NONCES = 256;
/** The most an action's form may carry; a steer or a tell is far below it. */
const MAX_ACTION_BYTES = 64 * 1024;

/**
 * What a nonce the page holds may do: the page's own runs any action once, and
 * one an irreversible action's first post minted runs that action alone, with
 * the very fields the operator was asked about, before it expires.
 */
type NonceGrant =
  | { kind: 'page'; mintedAt: number }
  | { kind: 'confirm'; action: ActionName; fields: string; mintedAt: number };

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

/**
 * Where the page's actions are taken (decision 91): the nonces it is handed,
 * and `POST /action`, which runs each action through the core call its CLI
 * command makes once its nonce is good.
 */
interface ActionDesk {
  /** A page nonce, for a stream that holds the secret. */
  mint: () => string;
  /** Every nonce handed out, dropped: the secret they rode on was revoked. */
  clear: () => void;
  /** A request to `/action` that carries the secret, from a page served at `origin`. */
  handle: (req: IncomingMessage, res: ServerResponse, origin: string) => void;
  /** Settles once every action still running has finished. */
  settle: () => Promise<unknown>;
}

export function createActionDesk(db: Database, repoPath: string): ActionDesk {
  const nonces = new Map<string, NonceGrant>();
  const running = new Set<Promise<unknown>>();

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
  /** The action's answer, once it ran; held by `settle` so the store outlives it. */
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
  // An irreversible action's first post runs nothing: it is asked only about
  // what could run, so fields the action would refuse, a debt reason without
  // its review-by, are refused here instead.
  const ask = (action: ConfirmedAction, fields: ActionFields, next: string): ActionAnswer => {
    let confirm: string;
    try {
      confirm = confirmationText(action, fields);
    } catch (error) {
      return { ok: false, message: scrubbed(error), nonce: next };
    }
    const bound = { action, fields: canonical(fields), mintedAt: Date.now() };
    return {
      ok: true,
      message: '',
      confirm,
      confirmNonce: mint({ kind: 'confirm', ...bound }),
      nonce: next,
    };
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
    const fields = fieldsOf(form);
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
    if (!isConfirmed(action)) return { ...(await run(action, fields)), nonce: next };
    return ask(action, fields, next);
  };

  /**
   * A post to `/action`. Only a form post naming this origin is read: a
   * browser names the origin of every post its pages make, and a form is what
   * the page's script sends; one that says it came from another site, or does
   * not say, is refused. A wrong, used or lapsed nonce is refused before
   * anything runs.
   */
  const handle = (req: IncomingMessage, res: ServerResponse, origin: string) => {
    if (req.method !== 'POST') return refuse(res, 405, 'POST only.');
    const site = req.headers['sec-fetch-site'];
    if (req.headers.origin !== origin || (site !== undefined && site !== 'same-origin')) {
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
      // A post the client gave up on mid-body: answered if anything can be.
      .catch(() =>
        res.headersSent ? res.end() : refuse(res, 500, 'The action could not be read.'),
      );
  };

  return {
    mint: () => mint({ kind: 'page', mintedAt: Date.now() }),
    clear: () => nonces.clear(),
    handle,
    settle: () => Promise.allSettled([...running]),
  };
}

/** A post's fields, less the nonce and the action's name. */
function fieldsOf(form: URLSearchParams): ActionFields {
  const fields: ActionFields = {};
  for (const [name, value] of form) if (name !== 'nonce' && name !== 'action') fields[name] = value;
  return fields;
}

/** The fields a confirmation is bound to, in one order whatever order the form sent them in. */
function canonical(fields: ActionFields): string {
  return JSON.stringify(Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Whether a nonce is past its time: a confirmation's, or a page's left unused. */
function lapsed(grant: NonceGrant, now: number): boolean {
  return now - grant.mintedAt > (grant.kind === 'confirm' ? CONFIRM_TTL_MS : PAGE_NONCE_TTL_MS);
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
