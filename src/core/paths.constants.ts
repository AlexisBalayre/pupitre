/**
 * What a session id may look like before anything joins it into a path. Ids
 * are pup-minted, but every reader gets them back out of a store the sessions
 * themselves can write, and since the fleet views (decisions 60-62) the
 * operator reads every registered project's store — so an id is untrusted
 * text. A closed allowlist rather than a `..` check: separators and dots are
 * not in it at all, so no combination of them composes into an escape
 * (decision 66; `dossierFileName` already applied it to report file names).
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
