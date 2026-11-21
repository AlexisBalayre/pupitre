import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ActionName } from './web-dashboard-actions.types.js';

/**
 * What a nonce the page holds may do: the page's own runs any action once, and
 * one an irreversible action's first post minted runs that action alone, with
 * the very fields the operator was asked about, before it expires.
 */
export type NonceGrant =
  | { kind: 'page'; mintedAt: number }
  | { kind: 'confirm'; action: ActionName; fields: string; mintedAt: number };

/** What `/action` answers once its nonce was good: the result or refusal, and what the page holds next. */
export interface ActionAnswer {
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
export interface ActionDesk {
  /** A page nonce, for a stream that holds the secret. */
  mint: () => string;
  /** Every nonce handed out, dropped, and every post still sending its body cut off: the secret they rode on was revoked. */
  clear: () => void;
  /** A request to `/action` that carries the secret, from a page served at `origin`. */
  handle: (req: IncomingMessage, res: ServerResponse, origin: string) => void;
  /** Settles once every post still running has been answered; `onWait` is called first when an action is running. */
  settle: (onWait?: () => void) => Promise<unknown>;
}
