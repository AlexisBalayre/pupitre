# 0091. `pup dashboard` serves a read-only live page on 127.0.0.1, behind a token minted per run, the UI-first surface (2026-10-16)

- Status: accepted
- Amended by: [0098](0098-pup-dashboard-is-a-set-of-sheets-figures.md)

91. **`pup dashboard` serves a read-only live page on 127.0.0.1, behind a token minted per run,
    the UI-first surface (2026-10-16).**
    `pup status` and `pup ui` are terminal text, and what the operator reads them for (who needs
    me, what runs, which PR waits, what debt is open) reads better as a page that keeps itself
    current. `pup dashboard [--open]` serves one page with `node:http`, no new dependency, bound
    to `127.0.0.1` on a random port, and prints its url with a token of 32 random bytes
    (base64url) minted for this run; `--open` hands the url to `open`/`xdg-open`. It is
    operator-only, refused to a session and the conductor before anything binds, since the page
    names the conductor's socket as `pup status` does only for the operator (decision 47). Ctrl-C
    or SIGTERM closes the server, its streams and the store.
    Threat model. The server is reachable by every local process, and above all by every page the
    operator's browser has open: any origin can make the browser request a loopback url, and a
    DNS name rebound to 127.0.0.1 can make that request same-origin and read the answer. So every
    request must carry the token, compared in constant time, which no other origin can learn,
    and a `Host` header that is exactly `127.0.0.1:<port>`, which a rebound name never sends
    (`localhost` is refused too); anything else is a 403 before the store is read, and anything
    but GET a 405. The token travels in the url, so every response carries `Referrer-Policy:
    no-referrer`, every outbound link `rel="noopener noreferrer"`, and `Cache-Control: no-store`.
    The page loads nothing from anywhere: its CSP is `default-src 'none'`, with the one inline
    script and the one inline style admitted by a nonce minted per response, `connect-src 'self'`
    for its event stream, and `base-uri`, `form-action` and `frame-ancestors` all `'none'`. What
    the token does not cover: another local user or process of the operator's own can read the url
    from the terminal or, for the instant `open` runs, its argv; they already hold the store,
    which is no worse. The page is read-only, so there is no CSRF to answer yet; the actions
    follow as their own change with a nonce per action and confirmations, and a merge on GitHub
    stays a link, never a button.
    What it shows is what `pup status` and `pup ui` read, off one `buildDashboardSnapshot`:
    `needsYou` first, in its order with each answer; the conductor, with its attach command;
    sessions in states other than `merged` and `killed`, grouped by state (blocked, running,
    awaiting-review, queued, rejected, then any other stored state), each with its goal headline,
    question, activity, rejections, context, newest steer, newest gate and the open debt it filed
    (a ledger description ending ` session <id>`, as every flag the gate files does, decision 86);
    each open PR with its CI review state; the backlog; and the open ledger, overdue entries marked.
    The CI review state is the store's half: `prFixRounds`, the `merge` events carrying a PR since
    the last `landed` one less the first, says how many fix rounds were re-gated, beside the newest
    gate's verdict, which on a refused re-gate is what says the PR still vouches for the earlier
    pin. What CI said is on the PR, which the page links to and does not ask GitHub about; the
    review state GitHub holds arrives with `pup fix` reading the bot's threads (decision 90). The
    board is rendered on the server and escaped there: every string is already through
    `sanitizeReason` (decision 29; the ledger fields here are scrubbed the same way) and then has
    `& < > " '` escaped, and the only element built from a store-read string is a link, made only
    of a url passing `PR_URL`, the check the inbox already prints by (decision 83), now exported
    from `dashboard.service.ts`. A url that fails it prints as text, or as the inbox's placeholder.
    The page carries the first render, and `/events` is a Server-Sent Events stream: it sends the
    board on connect, and while any stream is open the server re-reads the store every 2 s and
    sends the whole board to every stream when it rendered differently from the last, so an
    unchanged store sends nothing and the browser never polls. The script only swaps in the board
    the stream sends and says whether the stream is up. A store that cannot be read for one poll
    is skipped, and a request that reads it then gets a 500, not a dead server. Plain HTML, the
    report pages' theme tokens and shell (light and dark from `prefers-color-scheme`), long text
    wrapping so it reads at phone width. It replaces nothing: `pup status`, `pup ui` and `pup
    report` stay, and it is separate from Copiste's `pup serve` socket daemon, which stays as
    designed.
    Tests: over a real socket, the url is on 127.0.0.1 with a 43-character token that differs per
    run; no token, a wrong one, one a character short, and the stream without one are refused 403;
    a `Host` of a rebound name, of `localhost` and of another port is refused with the right token;
    a POST is a 405; the page's CSP admits only its nonce and its own stream, with no external
    source on the page. For one store holding a question, a block, a review, an open PR re-gated
    once with debt, a killed session, a planned task and an overdue entry, every inbox line's reason
    and answer is on the page in sections ordered as `pup status` prints them, the states group in
    order, the killed session is not listed, and the PR is a link with `re-gated after 1 fix round`
    and its debt. A goal holding markup, ESC and CSI and a question holding `</script>` render
    escaped with no control character left; a planted non-PR url and a `javascript:` one are never
    a link, nor is a PR url inside a question. A stream gets the board on connect, a new question
    within one poll, and nothing more while the store is unchanged. `prFixRounds` counts re-gates
    and stops at a landing and at a merge without a PR. The CLI prints the url, stops the server on
    SIGINT, and refuses a session and the conductor without binding.
