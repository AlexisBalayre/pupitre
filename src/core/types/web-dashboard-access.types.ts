import type { IncomingMessage } from 'node:http';

/**
 * Who may read and act on `pup dashboard`'s page (decision 91): the url's
 * token buys, once, a secret the page sends in its `X-Pup-Secret` header, and
 * the token coming back revokes it.
 */
export interface DashboardAccess {
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
