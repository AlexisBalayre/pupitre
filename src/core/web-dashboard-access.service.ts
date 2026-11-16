import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** The header the page's secret travels in; no other page can make a browser send it here. */
const SECRET_HEADER = 'x-pup-secret';
const FORBIDDEN = 'Forbidden.';
const REVOKED =
  'This url was opened a second time, so the page it opened first is cut off too. Run `pup dashboard` again for a new url.';

/**
 * Who may read and act on `pup dashboard`'s page (decision 91): the url's
 * token buys, once, a secret the page sends in its `X-Pup-Secret` header, and
 * the token coming back revokes it.
 */
interface DashboardAccess {
  /** The url's token, minted for this run. */
  token: string;
  /**
   * Why a page load naming `given` as its token is refused, or undefined when
   * it is not: no token, or the right one not yet spent. The right one spent
   * already revokes the secret, and `onRevoke` cuts off what it opened.
   */
  admit: (given: string | null) => string | undefined;
  /** The secret a page load holding the token is handed, minted now; none for a load without it. */
  spend: (given: string | null) => string | undefined;
  /** Whether a request carries the secret, compared in constant time. */
  holds: (req: IncomingMessage) => boolean;
  /** What a request without the secret is told: that it was revoked, if it was. */
  refusal: () => string;
}

export function createDashboardAccess(onRevoke: () => void): DashboardAccess {
  const token = Buffer.from(randomBytes(32).toString('base64url'));
  // Minted when the token is spent, and dropped for good when it comes back.
  let secret: Buffer | undefined;
  let exchanged = false;
  return {
    token: token.toString(),
    admit: (given) => {
      if (given === null) return undefined;
      if (!matches(given, token)) return FORBIDDEN;
      if (!exchanged) return undefined;
      secret = undefined;
      onRevoke();
      return REVOKED;
    },
    // Spent only on a page that goes out, so a first load naming no view
    // leaves the url good for the next.
    spend: (given) => {
      if (given === null) return undefined;
      exchanged = true;
      secret = Buffer.from(randomBytes(32).toString('base64url'));
      return secret.toString();
    },
    holds: (req) => {
      const given = req.headers[SECRET_HEADER];
      return secret !== undefined && typeof given === 'string' && matches(given, secret);
    },
    refusal: () => (exchanged && secret === undefined ? REVOKED : FORBIDDEN),
  };
}

/** Compared in constant time, so a wrong guess learns nothing from how long it took. */
function matches(given: string, secret: Buffer): boolean {
  const candidate = Buffer.from(given);
  return candidate.length === secret.length && timingSafeEqual(candidate, secret);
}

export const REFUSAL_CSP =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Headers every response carries. `no-referrer`, because the first url holds
 * the token and the page links out to pull requests; `no-store`, so the board is
 * not kept on disk by the browser.
 */
export function hardening(csp: string): Record<string, string> {
  return {
    'Content-Security-Policy': csp,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  };
}

export function refuse(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { ...hardening(REFUSAL_CSP), 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}
