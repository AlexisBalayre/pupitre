# 0091. `pup dashboard` serves a read-only live page on 127.0.0.1, behind a token minted per run, the UI-first surface (2026-10-16)

- Status: accepted
- Amended by: [0098](0098-pup-dashboard-is-a-set-of-sheets-figures.md), [0123](0123-the-health-sheet-charts-every-gate-metric-across.md)

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
    which is no worse for a page that only reads. The page was read-only at first, with no CSRF
    to answer; the actions came as part 2 below, which made the token worth more and so spends it
    on first use for a secret the page sends in a header, with a nonce per page and
    confirmations, and a merge on GitHub stays a link, never a button. Since part 2 the page
    itself is a shell holding nothing from the store, and the board comes over the stream.
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
    The page carried the first render until part 2, and `/events` is a Server-Sent Events stream: it sends the
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
    a POST anywhere but `/action` is a 405; the page's CSP admits only its nonce and its own stream, with no external
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

    **Part 2: the page acts (2026-11-13).** The console's operator actions are buttons on the
    page, each calling the core function its CLI command calls, never a shell:
    answer a session's or the conductor's open question (`answerSessionQuestion`,
    `answerConductorQuestion`; one click on an option of decision 93's, its number sent, or an
    answer in words), tell the conductor (`tellConductor`), steer a session (`steerSession`, a
    `manual` steer by `operator`), launch a backlog task (`launchTask`), kill a session
    (`killSession`), gate it with `--pr` and optionally accept its flags as debt with a reason,
    a review-by and an approver, the field holding `human` until the operator names someone else
    and refused when it is empty once scrubbed, as `--approved-by` is (`runMergeGate` with `openPr`
    and `acceptDebt`, refused as `pup merge` refuses a reason without its review-by), start a fix
    round (`startFixRound`), land (`landSession`, after the sandbox check `pup land` makes) and
    close a ledger entry (`closeLedgerEntry`). The page is the operator's alone, as `pup
    dashboard` refuses a session and the conductor, so every action runs as the operator's. A
    merge from the page is always `--pr`: the target branch moves only through `pup land` after
    the PR is merged on GitHub, which the page only links to; no button merges there. The gate,
    the land and the fix round take no lock wait: the page refuses at once where the CLI waits.
    Where they are: a question's answers and a tell under Needs you and Conductor, a launch on
    each planned and backlog task, a close on each open ledger entry, and the rest on a session's
    view, `?session=<id>` for a minted id the store holds (404 otherwise), linked from each
    session, need and PR row. The view shows the attach line `pup attach <id>` with a copy button,
    the PR link, the actions the session's state admits (steer, gate and kill while it runs; fix
    round, re-gate and land once merged), and a board the stream refreshes: the state, the open
    question with its answers, and the worker's pane, read by `capturePane` in
    `src/claude/session-runtime.service.ts` at the pane pinned at launch (decision 46), with
    control characters and direction marks replaced and markup escaped, line breaks kept. A pane
    tmux no longer has is said in its place.
    Threat model, restated. Acting, the page holds the operator's whole authority over the
    project: answer as the operator, accept debt as `human` or a named approver, steer as
    `operator`, launch, kill, gate and land, which the CLI refuses a session and the conductor
    (`callingSession`, `callingConductor`). A url token kept as part 1 kept it, in browser history
    and session restore, terminal scrollback and `open`/`xdg-open`'s argv (`/proc/<pid>/cmdline`
    on Linux), would hand that to any process of the operator's own that reads it. A cookie would
    not do either: cookies ignore ports, so the browser sends one set by 127.0.0.1:<port> to every
    server on 127.0.0.1, such as the dev or preview server a worker runs and asks the operator to
    look at, which could then act with it. So the authority is a secret of 32 random bytes that
    the page holds and sends in an `X-Pup-Secret` header, never a cookie. A page on another origin
    cannot make the browser send that header without a CORS preflight, which this server never
    answers. The url's token buys it once: the first page served for a `GET /` holding the token
    has the secret written into its script, which keeps it in the tab's `sessionStorage` (scoped
    to the origin, port and all, and gone with the tab) and takes the token out of the address bar
    and history with `history.replaceState`. No link on the page holds either. Pages loaded in
    that tab from its links read the secret back; another tab has none and says so. A first load
    the server cannot answer, an unknown view or an unreadable store, spends nothing. The token
    coming back a second time revokes the secret: the second load is refused, and so is every
    later request carrying the secret, so whoever took it first, from argv or scrollback, is cut
    off with the operator, who runs `pup dashboard` again. Every request but the page shell must
    carry the secret, compared in constant time: the stream, which the script reads with
    `fetch`, since an `EventSource` cannot send a header, and every post. The shell itself is
    served without it and holds nothing from the store, only the repo path and the view's name;
    the board, a session's attach line and actions included, comes over the stream. Where the
    authority lives: in the tab the url opened first, in its memory and session storage, which
    no other origin can read; while the url is unopened, in the url itself, printed to the
    terminal and, with `--open`, in `open`'s argv for an instant. What is left: a process of the
    operator's own that reads the url before the browser opens it wins the exchange, and the
    operator's own load then revokes it, which shows it; a process that can read the browser's
    memory or profile already holds the operator's account.
    CSRF. Each action is a form post to `POST /action`, which needs the secret, the loopback
    `Host` and a form content type, and an `Origin` that is exactly `http://127.0.0.1:<port>`: a
    post naming another origin or none is a 403, as is one whose `Sec-Fetch-Site`, when sent, is
    not `same-origin`. Each time the stream opens it hands the page an action nonce of 32 random
    bytes, so only the secret's holder can have one minted, and no other page can fill the map
    and push the operator's out. A post uses it up before anything else is read, and its answer
    carries the next one; a nonce the server never minted, one already used, or a page's left
    unused for 30 minutes is a 403 before anything runs, and changes nothing. The server holds
    at most 256 nonces: each mint sweeps the lapsed ones and, past the cap, drops the oldest,
    whose page is told to reload. One page holds one nonce, so it runs one action at a time; a
    reload mints another.
    Confirmation rule. Kill, merge, land and debt close cannot be taken back, so the first post
    of one runs nothing: it answers with the question to ask, naming what will run and with
    which fields, the debt accepted included, and a confirmation nonce bound to that action and
    those exact fields, good for five minutes and once. Only a second post carrying it runs the
    action; one naming another action or other fields is refused and uses it up. The page asks
    with the browser's own confirm dialog. Answer, tell, steer, launch and fix run on their first
    post.
    What comes back is JSON the script sets as text, never markup: the lines the CLI would print,
    or core's refusal as core worded it, control characters replaced and lines kept, in a status
    line under the sheet bar. The board is held back while the operator types into a field on it,
    so a refresh does not wipe a half-typed answer. `close` waits for an action still running
    before the store is closed.
    Tests: per action, the core function the CLI calls is called with the CLI's arguments and its
    refusal is what the page shows; an approver missing, blank or empty once scrubbed is refused
    and gates nothing, and a tell without a message is refused before the conductor is reached;
    the first page served for the token is handed a secret, sets no cookie and strips the token
    from the address bar, a page loaded without the token is handed nothing, and the shell holds
    nothing from the store; a first load answered 404 spends nothing; the token coming back is
    refused and revokes the secret, after which the stream and posts carrying it are refused and
    change nothing; the stream without the secret, with a wrong one, with the token in its place
    or with only a cookie is a 403; a post without the secret, with a wrong one, with the token,
    with only a cookie, from another origin, naming no origin, or with a cross-site or same-site
    `Sec-Fetch-Site`, with a wrong, reused or lapsed nonce, or a reused confirmation is refused and
    leaves the ledger entry open; past the cap the oldest nonce is refused; kill, merge, land and debt close each answer only a confirmation on the
    first post and change nothing; a confirmation runs only its own action and fields. The
    session view, tmux faked, shows a pane holding markup, ESC and a direction mark escaped, the
    copyable attach line, and a new pane on its stream within a poll; a merged session's view links
    its PR and offers fix, re-gate and land, no form naming GitHub.
