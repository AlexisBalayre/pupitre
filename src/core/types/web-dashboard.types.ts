import type { Server } from 'node:http';
import type { SheetName } from './web-dashboard-sheet.types.js';
/** What a marked list of the web dashboard shows: the rows matched, its page of them, and how many pages there are. */
export interface ListWindow {
  shown: number[];
  matched: number;
  page: number;
  pages: number;
}

/** What a page shows: a sheet, or one session's view (decision 91). */
export type View = { sheet: SheetName } | { session: string };

export interface WebDashboard {
  /** The page, token included: the one url that opens it, in one browser, once. */
  url: string;
  /** Stops the server; `onWait` is called first when an action still running holds the close. */
  close: (onWait?: () => void) => Promise<void>;
}

/**
 * Puts the dashboard's server where requests reach it, and resolves to the
 * port its url names. A test hands the server in-memory connections instead
 * of a socket, since a sandboxed worker may not listen on loopback (decision 191).
 */
export type DashboardBind = (server: Server) => Promise<number>;

/** What a page is made of beside the shell. */
export interface PageParts {
  title: string;
  /** The sheet the bar marks as this page; none on a session's view. */
  current?: SheetName;
  /** The response's CSP nonce, for its one script and one style. */
  nonce: string;
  /** The secret, on the one page the url's token opened (decision 91). */
  secret?: string;
}
