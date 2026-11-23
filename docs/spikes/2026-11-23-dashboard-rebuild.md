# Spike: rebuild the pup dashboard as an operator cockpit (2026-11-23)

`pup dashboard` today is a set of sheets (decision 98) that show what the project
is becoming, with the operator's actions bolted on (decision 91, part 2). The
operator wants one screen that answers *what needs me now*, and then lets them
answer, steer, review, gate and land without opening a terminal. This spike
designs that cockpit: the jobs, the screens and their order, the home screen's
hierarchy, a design system written as CSS custom properties, the interaction and
live-update model, accessibility, what the page may show and do under decision
91's token and loopback rules, which parts of decisions 91 and 98 it amends, and
a slice plan that goes straight to `pup plan add`. Nothing under `src/` changes
here.

**Verdict: rebuild in place, in eight vertical slices behind the same `pup
dashboard` command, on the current stack (server-rendered HTML, one small inline
script, the existing SSE stream; no framework, no build step, no dependency).**
The security design of decision 91 survives whole. What changes is the look, the
shape of the live stream (per-region patches instead of swapping the whole
board), the confirmation dialog, and four new reads: usage and cost, a review
diffstat, other projects' counts, and the screens' own ordering.

Mockups open from the file with no network, in `docs/spikes/dashboard-rebuild/`:
[home](dashboard-rebuild/home.html) · [session](dashboard-rebuild/session.html) ·
[review](dashboard-rebuild/review.html) · [backlog](dashboard-rebuild/backlog.html) ·
[debt](dashboard-rebuild/debt.html) · [usage](dashboard-rebuild/usage.html) ·
[projects](dashboard-rebuild/projects.html). All seven link
[`dashboard.css`](dashboard-rebuild/dashboard.css), the design system below, and
nothing else. They follow `prefers-color-scheme`, so flip the OS theme to see dark.

## What exists today

Read from `src/core/` and decisions 91, 98 and 123.

- **Server.** `web-dashboard.service.ts` runs `node:http` on `127.0.0.1`, random
  port. Routes: `/` (the shell), `/events` (SSE), `POST /action`. Guards: exact
  `Host`, per-run token spent once for a secret held in `sessionStorage` and sent
  as `X-Pup-Secret`, per-page action nonces, `Origin` and `Sec-Fetch-Site`
  checks, a nonce-only CSP (`default-src 'none'`, no `style` attribute).
- **Stream.** Every 2 s the server re-renders each open sheet; if its HTML differs
  from the last it sends the **whole board**. The script swaps it in unless a
  field has focus or holds unsent text, then shows `held` beside `live`.
- **Sheets.** Overview, Debt, Health, Tasks, Decisions, plus `?session=<id>`. The
  column is 960 px; the theme tokens are the report pages' shared shell.
- **Actions** (`web-dashboard-actions.service.ts`): answer, tell, steer, launch,
  kill, merge (always `--pr`), fix, land, debt-close. Kill, merge, land and debt
  close take a server-minted confirmation nonce and today ask through the
  browser's `confirm()`.
- **Data.** `buildDashboardSnapshot` gives sessions (with `needsHuman`,
  `question`, `lastGate`, `gateRefused`, `openPr`, `fixCommitted`, `activity`,
  `stalledAgeMs`, `contextTokens`), `needsYou` (inbox order: question, conductor,
  blocked, top-rung, stalled, awaiting-review, fix-committed, pr-open), backlog,
  debt and overlaps. Usage and cost are **not** in the snapshot: `pup usage`
  builds a `UsageReport` from Claude transcripts. Other projects are not read at
  all: the server is bound to one project's store.

What the operator feels today: the Overview already leads with a status strip and
Needs you (the 2026-11-18 amendment), but it is 960 px of dense text, state is
colour and a word, answers sit far from their question, a refresh can still move
what you are reading, and kill or land is a native `confirm()` that names nothing
the server has not already said.

## The jobs, and the order of the screens

The cockpit exists for these jobs, ranked by how often the operator does them.

| # | Job | Trigger | Screen | Existing action |
| - | --- | --- | --- | --- |
| 1 | See what needs me | opening the page, a count change | **Home** | none, reads `needsYou` |
| 2 | Answer a worker's question | `question` need | Home (inline), Session | answer, tell |
| 3 | Steer or unstick a worker | `blocked`, `stalled`, drift | **Session** | steer, kill |
| 4 | Review finished work and decide | `awaiting-review`, `gateRefused` | **Review** | merge `--pr`, accept debt, steer |
| 5 | Land after merging on GitHub | `pr-open`, `fix-committed` | Home, Session | fix, land |
| 6 | Feed the fleet | free slot, empty queue | **Backlog** | launch |
| 7 | Decide debt | overdue entry, refused gate | **Debt** | debt-close |
| 8 | Watch spend | habit, a surprise bill | **Usage and cost** | none |
| 9 | Hop between projects | several registered | **Projects** | none (see "What the page may show or do") |

The screens, in the order they are built and the order they appear in the nav:

1. **Home** (`?sheet=home`, replaces Overview). Needs me, live sessions, the rest.
2. **Session** (`?session=<id>`). One worker: pane, steer, events, task, kill.
3. **Review** (`?session=<id>&view=review`). The gate result, the acceptance
   criteria, the diffstat and the decision, for one awaiting-review session.
4. **Backlog** (`?sheet=backlog`, replaces Tasks). One line per task, launch.
5. **Debt** (`?sheet=debt`). Figures, files carrying the most, entries, close.
6. **Usage and cost** (`?sheet=usage`). New; today only `pup usage` shows it.
7. **Projects** (`?sheet=projects`). New; today only `pup status` outside a repo.

Health (decision 123) and Decisions (the day-grouped record) keep their data and
their charts and move under a **More** link in the nav, restyled with the system
in slice 6. They are not part of the cockpit's loop, so they are not dropped and
not redesigned here.

The nav is a flat bar of five links (Home, Backlog, Debt, Usage, Projects) plus
More. Session and Review are reached from rows, never from the nav; each has a
breadcrumb back to Home. Home carries the needs-me count in the nav and the
document title (`(3) Home — pup dashboard`), so a pinned tab is a status light.

## Home: the information hierarchy

The page answers one question per band, top to bottom. Nothing above a band is
ever pushed below the fold by a band beneath it.

1. **Chrome (one line).** Project, nav with the needs-me count, a `live` chip with
   the last update time. If the stream is down the chip says `reconnecting` in the
   bad colour; if a region is held it says `held` (see Live updates).
2. **Needs me**, full width, with a heavy border. Each item is a card in the
   inbox's own order (question, conductor, blocked, top-rung, stalled,
   awaiting-review, fix-committed, pr-open) and **carries its own control**: a
   question shows its numbered options as buttons with the recommended one
   primary, plus a field for an answer in words; a refused gate shows *Review and
   decide*; an open PR shows *Open PR* and a disabled *Land (after merge)* that
   enables once the server says the target branch has not caught up and the PR is
   merged. The only thing the operator must leave the page for is merging on
   GitHub. Empty: a calm line, *Nothing needs you*, with the newest event and
   when it happened, so silence reads as a verdict and not as a broken page.
3. **Live sessions**, left two thirds, grouped by state in decision 91's order:
   blocked, running, awaiting review, queued, rejected. One row each: state chip
   (glyph, word, colour), goal headline cut at a word boundary, one line of
   facts, one button. A session that already has a Needs-me card points at it
   instead of repeating its question (as decision 98 already does). `merged` and
   `killed` are not listed.
4. **The rest**, right third, in this order: **Next up** (first two backlog tasks
   with Launch, a link to the rest), then **Project** (three figures: open debt
   with overdue, coverage with its weekly change, spend today). Gate metrics,
   charts and the delivery history leave Home; Debt and Health own them.

Below 52 rem the thirds stack in the same order. At 1512×812 the first screen
holds the chrome, Needs me with up to three cards, and the head of Live
sessions. The measure is 72 rem, up from 60.

What Home deliberately drops from today's Overview: the four sparkline tiles, the
Delivery charts, the goal text, and the Conductor row as its own section. The
conductor's question is a Needs-me card; its state is one chip in the chrome when
it is out of reach.

## Design system

Written as CSS custom properties in
[`dashboard.css`](dashboard-rebuild/dashboard.css); the block below is a verbatim
copy of its token layer, and the file is the source of truth. In production the
file is inlined into the page's one nonce'd `<style>` (decision 91: nothing
loaded, no `style` attribute), so a component uses a class and never an inline
style; the width classes `w-10 … w-90` in the mockups stand for a fixed ladder of
such classes, since a bar's width cannot be a style attribute.

```css
:root {
  color-scheme: light dark;

  /* type: system stack, no webfont (CSP loads nothing) */
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --text-xs: 0.75rem;   /* 12: meta, chips */
  --text-sm: 0.875rem;  /* 14: rows, tables */
  --text-md: 1rem;      /* 16: body */
  --text-lg: 1.25rem;   /* 20: section heads */
  --text-xl: 1.625rem;  /* 26: page title, big figure */
  --leading-tight: 1.25;
  --leading-body: 1.5;

  /* spacing: 4 px base */
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.5rem;
  --space-6: 2rem;
  --radius: 0.5rem;
  --measure: 72rem;      /* page column, replaces 960 px */
  --target: 2.5rem;      /* min hit area */

  /* surfaces and text (light) */
  --bg: #f6f7f8;
  --surface: #ffffff;
  --surface-2: #eef0f2;
  --border: #cfd4d9;
  --border-strong: #78818a;  /* control edges, >= 3:1 */
  --text: #1a1d20;
  --text-muted: #545b62;
  --accent: #0b5394;
  --on-accent: #ffffff;
  --focus: #0b5fff;

  /* state colours: --state-X-fg on --state-X-bg, all >= 4.5:1; never colour alone */
  --state-need-fg: #8a4b00;    --state-need-bg: #fff1d9;
  --state-run-fg: #0b4a85;     --state-run-bg: #e6f0fb;
  --state-ok-fg: #146c2e;      --state-ok-bg: #e3f3e8;
  --state-bad-fg: #a4262c;     --state-bad-bg: #fce8e8;
  --state-idle-fg: #484e55;    --state-idle-bg: #e9ecef;

  --motion: 120ms;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111315;
    --surface: #1a1d20;
    --surface-2: #24282c;
    --border: #3a4046;
    --border-strong: #78828b;
    --text: #e8eaed;
    --text-muted: #a6adb4;
    --accent: #8ab8f0;
    --on-accent: #0b1b2e;
    --focus: #9cc4ff;

    --state-need-fg: #ffc46b;  --state-need-bg: #3a2a0f;
    --state-run-fg: #8ab8f0;   --state-run-bg: #12263f;
    --state-ok-fg: #7fd49a;    --state-ok-bg: #123221;
    --state-bad-fg: #ff9a9a;   --state-bad-bg: #3d1517;
    --state-idle-fg: #b4bac1;  --state-idle-bg: #2a2e32;
  }
}

@media (prefers-reduced-motion: reduce) {
  :root { --motion: 0ms; }
}
```

**Type.** System stack only (a webfont is a load the CSP refuses). Five sizes on
a roughly 1.2 scale from 12 to 26 px; body is 16 px at 1.5, rows and tables 14,
meta and chips 12; `tabular-nums` on every figure so live changes do not jitter.
Weight carries hierarchy (600 for names and chips, 650 for figures), not extra
sizes.

**Spacing.** A 4 px base with six steps; panels pad 16, sections gap 24, rows pad
12. Hit areas are at least 40 px (`--target`).

**Colour.** Surfaces and text are neutral; one accent for links and the primary
action; five **state** pairs. Every state is a foreground on its own tinted
background, and every state chip also carries a glyph and a word, so colour is
never the only signal (`▲ attn`, `● run`, `✓ ok`, `✕ bad`, `○ idle`).

| State | Used for |
| --- | --- |
| `need` | question, stalled, awaiting review, gate refused, overlap |
| `run` | running |
| `ok` | passed, PR open and green, live |
| `bad` | blocked, overdue, error, refused action, stream down |
| `idle` | queued, dormant, unchecked |

Measured contrast (WCAG relative luminance, computed from the file's own values):

| Pair | Light | Dark |
| --- | --- | --- |
| text on surface | 16.9 | 14.0 |
| muted text on surface / surface-2 | 6.9 / 6.0 | 7.5 / 6.5 |
| accent on surface; on-accent on accent | 7.8; 7.8 | 8.2; 8.4 |
| need, run, ok, bad, idle fg on its bg | 6.1, 7.8, 5.7, 6.2, 7.1 | 8.8, 7.4, 7.8, 7.9, 7.0 |
| focus ring on surface (needs 3) | 5.1 | 9.5 |
| control border on surface (needs 3) | 4.0 | 4.3 |

The decorative `--border` (1.5 and 1.6) separates panels only; every control edge
uses `--border-strong`. Slice 1 turns this table into a test that parses the CSS
and fails below 4.5 for text pairs and 3 for the ring and control edges, so a
later token edit cannot regress it.

**Motion.** One transition: background colour on buttons, `120ms`. No animation,
no transform, no scroll-linked effect. `prefers-reduced-motion: reduce` sets
`--motion: 0ms`. A live change is never animated; it is announced (see below).

**Charts** keep decision 98's inline SVG, `<title>` and screen-reader figure line;
their marks take the accent and state tokens through classes.

## Interaction patterns

**Keyboard.** Handled by one `keydown` listener on `document`, ignored while a
field, select or dialog has focus, and when a modifier is held.

| Keys | Does |
| --- | --- |
| `?` | open the shortcut list (a dialog) |
| `g` then `h` `b` `d` `u` `p` | go to Home, Backlog, Debt, Usage, Projects |
| `j` / `k` | move the selection down or up in the list on the page |
| `Enter` | open the selected row's session or review |
| `a` | focus the selected need's answer field |
| `s` | on a session, focus the steer field |
| `/` | focus the page's filter |
| `Esc` | close a dialog, then clear the filter, then leave a field |

No single key ever runs an action. `a` and `s` only move focus; the operator
presses a button. Kill, land, gate and debt close have no shortcut at all. The
selection is `data-selected` plus `aria-current="true"` on the row, kept by key
across live updates.

**Empty states** say what it means and what to do next, once: *Nothing needs you*
(Home), *No tasks planned. `pup plan add` files one* (Backlog), *No open debt*
(Debt), *No usage in this window; try a longer range* (Usage). **Loading**: the
shell is served with regions holding two to four `.skeleton` lines, replaced as
the first stream frame arrives; a region that has not arrived after 3 s says so
rather than staying a skeleton. **Error**: a refused action puts core's wording in
an `.error` block next to the button that was pressed, with `role="alert"`, and
keeps the typed text; a region the server cannot render shows an `.error` in its
own place and leaves the other regions live (decision 98's isolation, kept); a
dropped stream shows `reconnecting` in the chrome and retries after 1, 2, 4 then
10 s.

**Destructive actions.** The server's two-step rule (decision 91: the first post
runs nothing and answers with what would run plus a single-use confirmation
nonce) is unchanged. Only the asking changes: instead of `confirm()`, the page
opens a `<dialog>` (see the review mockup) built from the server's answer. It
names the exact command, every field, the debt accepted, who approves it and the
review-by date; its **safe button is first in the tab order and holds the
initial focus**; the dangerous button is labelled with the verb, not *OK*; `Esc`
cancels. Kill, merge, land and debt close use it. Answer, tell, steer, launch and
fix still run on the first post.

## Live updates without losing scroll or focus

Today the server sends the whole board and the page swaps it. That is why a
refresh can move what the operator is reading. The rebuilt stream sends **regions**.

- **Server.** Each screen is a list of regions, each a fragment with a stable id
  (`needs`, `sessions`, `next`, `project`; `pane`, `events` on Session). On every
  2 s poll the server renders each region, hashes it, and sends only regions whose
  hash changed since that stream's last frame: `event: region`, data
  `{"id","html"}`, as JSON. On connect it sends all of them. Rendering, escaping
  and the CSP are exactly decision 91's; a region is a slice of what the board is
  now. An unchanged store still sends nothing.
- **Client.** The script finds `[data-region=<id>]` and reconciles its children by
  `data-key` (a session id, a task id, a ledger id): a key whose `outerHTML` is
  equal is left untouched, so its focus, selection, scroll and half-typed text
  survive; a changed key is replaced; a new key is inserted in order; a gone key
  is removed. About 60 lines, no library.
- **Hold.** A region is **held** while it contains the focused element, a dirty
  field or an open `<dialog>`. Frames for it are kept (latest wins) and applied
  once the field is sent, cleared or blurred. Other regions keep updating. The
  chrome shows `held` only when a region is held, and the held region shows a
  small `held` chip, so a stale card is never read as live. This narrows
  decision 91's rule, which holds the whole board.
- **Scroll.** Before a patch the script records the first visible keyed row and
  its offset from the viewport top; after the patch it scrolls by the difference,
  so rows inserted above the reader do not push the page. Scrollable panes (the
  worker pane) keep their `scrollTop` unless they were already at the bottom, in
  which case they follow.
- **Focus.** If the focused element is inside a replaced node, the script
  restores focus to the element with the same `data-focus` id, else to the nearest
  surviving ancestor.
- **Announcements.** One visually hidden `aria-live="polite"` region receives
  *New: t-mwt2k1 asks a question* when a key appears in Needs me, and nothing for
  other changes. The document title carries the needs-me count.
- **Reconnect.** The stream is read with `fetch`, because `EventSource` cannot
  send the secret header (decision 91). On a drop the script backs off as above;
  on reconnect the server resends every region, so no `Last-Event-ID` is needed.

## Accessibility

- **Landmarks.** `header` (banner with the project, `nav aria-label="Screens"`,
  the live status), `main#main`, `aside` for a screen's side column with an
  `aria-label`, `footer` for the shortcut hint. A skip link is the first
  focusable element. One `h1` per screen (screen-reader-only on Home, where the
  Needs-me panel leads); sections are `section` with `aria-labelledby` their `h2`.
- **Focus order** is the visual order, top to bottom: skip link, nav, Needs me
  cards (each: link, options, field, send), Live sessions, side column. No
  positive `tabindex`; the worker pane gets `tabindex="0"` to scroll by keyboard.
  The focus ring is 3 px, offset, visible on every control (`:focus-visible`).
- **State is never colour alone**: glyph + word + colour, enforced by `.chip`.
- **Tables** have captions (screen-reader-only), `scope` on headers and numbers
  right-aligned with tabular figures.
- **Live regions**: `role="status"` on the chrome indicator, `role="alert"` on a
  refused action, one polite announcer for new needs.
- **Dialogs** are native `<dialog>` opened with `showModal()`: focus trap and
  `Esc` come from the platform; focus returns to the opener on close.
- **Reduced motion** is the token above. There is no autoplay, no marquee, no
  timed content apart from the 5-minute confirmation, which the dialog states.
- **Zoom and reflow**: 200% zoom and 320 px width keep every control reachable
  (`.split` collapses, rows wrap); sizes are `rem`.
- **No-script**: the shell is served without the board, so with scripting off the
  page shows nothing from the store, as today; this is the price of decision 91's
  rule that the shell holds nothing from the store, and is not changed.

## What the page may show or do under decision 91

The token, secret, Host guard, nonces, CSRF checks, CSP and the operator-only
refusal are **unchanged and every new screen is held to them**. Concretely:

- **Every request** but the shell needs the secret; every new region and screen
  is delivered over the stream, so the shell still holds nothing from the store.
- **Every store-read string** goes through `sanitizeReason`, `displayText` and
  `escapeHtml`, and the only element built from one is a PR link passing
  `PR_URL`. New fields (diffstat paths, model names, project ids, project paths)
  take the same path.
- **The CSP stays** `default-src 'none'`, nonce'd script and style, no inline
  `style=`, `connect-src 'self'`. A `<dialog>` and CSS are within it. No image,
  font or icon is loaded; glyphs are Unicode characters in `::before`.
- **Storage.** Only `sessionStorage` for the secret (decision 91). No cookie, no
  `localStorage`, no theme toggle: the OS decides light or dark.
- **Actions** stay the existing nine, each calling the core function its CLI
  command calls, all through `POST /action`. **No new action is added.** A merge
  stays `--pr`, never a button on GitHub's side; Land is the only way the target
  branch moves.
- **New reads**, each read-only and bounded:
  - *Review diffstat.* File paths and added/removed counts for the session's
    branch against its base, read by a core function the slice names (open
    question 3), never file contents.
  - *Usage and cost.* Aggregates only (class, model, effort, cost, shares, cache
    rate), never transcript text, tool arguments or prompts. The report scans
    transcripts on disk, so it is **not** run on the 2 s poll: it is built on
    demand and cached for 60 s, with the age shown.
  - *Projects.* Per project: name, state, needs-you count, running, open PRs, open
    debt. Read from each project's store without taking its lock, read-only; no
    session text, no goals, no questions. **No action and no link carries a token:**
    acting on another project means running `pup --project <id> dashboard`, which
    mints that project's own token. One page therefore never holds authority over
    two projects, which keeps decision 91's threat model intact.
- **Never**: a shell, an arbitrary path read, a third-party request, a new route
  that mutates on `GET`, a button that acts on a project other than the one the
  token was minted for, a single-key destructive shortcut.

## Which parts of decisions 91 and 98 the rebuild amends

Everything not listed stands.

**Decision 91**
- *"Plain HTML, the report pages' theme tokens and shell (light and dark from
  `prefers-color-scheme`), long text wrapping so it reads at phone width"*: the
  dashboard gets its own token layer and shell (above); light and dark and phone
  width are kept.
- *"sends the whole board to every stream when it rendered differently"* and
  *"the script only swaps in the board the stream sends"*: the stream sends
  changed **regions**, and the script reconciles them by key.
- *Part 2, "the board is held back while a field on it has focus…"*: the hold is
  per region, and the page says which region is held.
- *Part 2, "The page asks with the browser's own confirm dialog"*: it asks with a
  modal `<dialog>`. The server's confirmation nonce and its five minutes are
  unchanged.
- *"What it shows is what `pup status` and `pup ui` read, off one
  `buildDashboardSnapshot`"*: two screens read elsewhere, Usage (a cached
  `UsageReport`) and Projects (each project's store, read-only), and Review adds a
  diffstat.
- *The dashboard serves one project (the snapshot carries one `projectId`)*: the
  Projects screen reads others' counts, never acts on them.

**Decision 98**
- *"a bar of plain links across the top (Overview, Debt; Health, Tasks and
  Decisions…)"* and the sheet names: Overview becomes Home, Tasks becomes
  Backlog, Usage and Projects are added, Health and Decisions move under More.
  `?sheet=overview` and `?sheet=tasks` become 404, as any unknown name is.
- *"Each sheet has its own event stream"*: kept, but a stream carries its screen's
  regions, and Session and Review are screens with their own.
- *The Overview's order and the 2026-11-18 amendments* (status strip, then Needs
  you, live sessions, open PRs, conductor, planned, goal, four tiles, delivery
  charts; the 960 px column; one line per row): replaced by the Home hierarchy
  above and the 72 rem measure. The `clipWords` rule at 100 characters stays.
- *"Rejected: Tabs switched by script"*: kept. Screens remain separate server
  renders reached by links; only regions inside a screen are patched.
- *Charts, `CHART_CSS`, the `sr-only` figure line, the Debt sheet's summary, two
  charts and one table, and the `data-list` filter and pager*: kept, restyled.
- *The sparkline tiles and Delivery charts on the Overview*: they leave Home; the
  figures live on Debt and Health.

Decision 123 (the Health sheet) is untouched apart from its place in the nav. The
amendments land as a new decision per slice that makes them (slices 1, 2, 4, 7
and 8), written in `docs/adr/` by the slice, since this spike may not.

## Slice plan

Eight tasks, each a vertical slice that leaves `pup dashboard` working and
tested. Order matters: 1 and 2 are foundations every screen uses, 3 delivers the
cockpit's main value, 4 and 5 close the answer, steer, review, gate and land
loop, 6 to 8 add the rest. Each block is written for `pup plan add --scope
<globs> --accept <criteria>`. The `test/` globs follow the existing
`test/unit/core/web-dashboard*.test.ts` names.

### 1. Design system and shell

Scope-in: `src/core/web-dashboard*.service.ts`, `src/core/web-dashboard*.utils.ts`,
`src/core/constants/web-dashboard*.constants.ts`, `test/unit/core/web-dashboard*.test.ts`,
`docs/adr/**`
- The page's one nonce'd `<style>` carries the spike's token layer and component
  classes; the report pages' shell is no longer used by the dashboard.
- Every existing sheet renders under the new shell: skip link, banner with nav
  (Home, Backlog, Debt, Usage, Projects, More), `main`, `h1`, and the footer
  hint; no `style=` attribute anywhere; the CSP is byte-identical to today's.
- A test parses the tokens and fails when a text pair falls under 4.5:1 or the
  focus ring or control border under 3:1, in light and dark.
- State chips carry glyph, word and colour on every sheet that shows a state.
- Keyboard: `?`, `g` then a letter, `j`/`k`, `Enter`, `/`, `Esc` work as the table
  says, are ignored in fields and dialogs, and no key runs an action.
- A decision amends 91 (theme tokens and shell) and 98 (sheet names and bar);
  `bash scripts/adr-index.sh --check` passes.
- Existing dashboard tests pass unchanged apart from markup they asserted.

### 2. Live regions over the stream

Scope-in: `src/core/web-dashboard.service.ts`, `src/core/web-dashboard-desk.service.ts`,
`src/core/web-dashboard-sheet.utils.ts`, `src/core/types/web-dashboard.types.ts`,
`test/unit/core/web-dashboard*.test.ts`, `docs/adr/**`
- A screen is a list of regions with stable ids; a stream sends all regions on
  connect and afterwards only regions whose rendered HTML changed; an unchanged
  store sends nothing; a region that cannot render does not end or starve the
  others (decision 98's isolation, kept).
- The script reconciles a region's children by `data-key`: a test with a DOM
  stand-in shows an unchanged key keeps its node, a changed one is replaced, a new
  one is inserted in order and a gone one removed.
- A region holding focus, a dirty field or an open dialog is held and updated
  after it is sent, cleared or blurred; other regions still update; the chrome and
  the region say `held`.
- Scroll position of the first visible keyed row is preserved across an insert
  above it; a pane at its bottom follows, one scrolled up stays.
- A single `aria-live="polite"` announcer speaks a new needs-me key and nothing
  else; the title carries the needs-me count.
- The stream is still read with `fetch` and the secret header; a dropped stream
  shows `reconnecting`, retries at 1, 2, 4, 10 s, and on reconnect resends every
  region.
- A decision amends 91 (whole-board swap, whole-board hold).

### 3. Home: needs me, live sessions, the rest

Scope-in: `src/core/web-dashboard-overview.service.ts`,
`src/core/web-dashboard-home*.service.ts`, `src/core/web-dashboard-sheet.utils.ts`,
`src/core/web-dashboard.service.ts`, `test/unit/core/web-dashboard*.test.ts`
- `?sheet=home` serves the hierarchy of the spike in four regions (`needs`,
  `sessions`, `next`, `project`); `?sheet=overview` is a 404 and the overview
  service's replaced code and tests are deleted.
- Needs me lists `needsYou` in its order, each card with its own control: a
  question's options (recommended primary) and an answer-in-words field calling
  the existing answer action; a refused gate links to Review; an open PR shows its
  link and a Land button enabled only when the server says it can land.
- An empty Needs me renders *Nothing needs you* and the newest event with its age.
- Live sessions group by state in decision 91's order, omit merged and killed,
  and a session that has a Needs-me card does not repeat its question.
- Next up shows two tasks with Launch; Project shows open debt with overdue,
  coverage with its weekly change, and spend today (blank until slice 7).
- Goals and questions are cut by `clipWords`; every string is through
  `sanitizeReason`, `displayText`, `escapeHtml`; the planted-markup tests of
  decisions 91 and 98 pass against Home.
- At 1512×812 the chrome, Needs me and the head of Live sessions are in the first
  screen on this repository's data, recorded in the task's notes.

### 4. Session screen and in-page confirmation

Scope-in: `src/core/web-dashboard-session.service.ts`,
`src/core/web-dashboard-desk.service.ts`, `src/core/web-dashboard-actions.service.ts`,
`src/core/constants/web-dashboard-actions.constants.ts`, `test/unit/core/web-dashboard*.test.ts`,
`docs/adr/**`
- `?session=<id>` shows state chip, goal, branch, context against its compaction
  point, the worker pane (read as decision 91 reads it), steer form, recent events,
  acceptance, scope with rescoped globs and the route, in the mockup's layout.
- The pane, events and task side column are separate regions; the steer field
  keeps its text and focus across updates.
- Kill, land, gate and debt close ask through a native `<dialog>` built from the
  server's confirmation answer: it names the command and every field, its safe
  button holds the initial focus, `Esc` cancels, and the first post still runs
  nothing; `window.confirm` is no longer called anywhere.
- A refused action shows core's words in an `.error` with `role="alert"` beside
  its button and keeps the typed text.
- An id outside the minted shape is 404; one the store does not hold says so on
  the stream; the attach line has a copy button.
- A decision amends 91 (browser confirm becomes a dialog).

### 5. Review screen

Scope-in: `src/core/web-dashboard-review*.service.ts`, `src/core/web-dashboard-session.service.ts`,
`src/core/web-dashboard-actions.service.ts`, `src/core/dashboard.service.ts`,
`src/core/types/dashboard.types.ts`, `test/unit/core/web-dashboard*.test.ts`,
`test/unit/core/dashboard.test.ts`
- `?session=<id>&view=review` for an awaiting-review session shows the newest
  gate's verdict and each check, every acceptance criterion with the gate's
  finding or *unchecked*, the diffstat (paths and counts only, through
  `displayText`), and whether the diff stayed in scope-in.
- The decision panel offers *Gate with PR*, *Steer to fix first* and the debt
  acceptance fields (reason, review-by, approver defaulting to `human`), refused
  as `pup merge` refuses a reason without its review-by or an empty approver; the
  gate confirms through slice 4's dialog and always opens a PR.
- After the PR is merged on GitHub the same screen offers fix round and Land per
  decision 91, naming each peer a land could not steer.
- A session in another state links back to its Session screen.
- The diffstat read is bounded (file count and bytes), cached per head commit, and
  never runs on the poll for a session that is not being viewed.

### 6. Backlog and Debt, restyled; Health and Decisions under More

Scope-in: `src/core/web-dashboard-tasks.service.ts`, `src/core/web-dashboard-debt.service.ts`,
`src/core/web-dashboard-health.service.ts`, `src/core/web-dashboard-decisions.service.ts`,
`src/core/web-dashboard-sheet.utils.ts`, `src/core/chart.utils.ts`,
`test/unit/core/web-dashboard*.test.ts`, `test/unit/core/chart.test.ts`
- `?sheet=backlog` replaces Tasks (`?sheet=tasks` is a 404): one row per task with
  scope, criteria count, an overlap chip when there is one, and Launch, which
  explains a refusal in place; the `data-list` filter and 20-row pager stay.
- Debt shows the three figures, the files-carrying-most table and the entries in
  pay-down order with overdue chips and a Close that confirms through slice 4's
  dialog; decision 98's kinds, ages, weights and file-less entries are unchanged.
- Health and Decisions render under the new shell and tokens; their charts take
  state and accent tokens through classes and still carry `<title>` and a
  screen-reader figure line; More links to both.
- Every sheet's empty state says what it means and what to do next.
- All existing Debt, Tasks, Health, Decisions and chart assertions on content still
  pass; only markup assertions change.

### 7. Usage and cost

Scope-in: `src/core/web-dashboard-usage*.service.ts`, `src/core/usage-report*.service.ts`,
`src/core/web-dashboard.service.ts`, `src/core/web-dashboard-sheet.utils.ts`,
`test/unit/core/web-dashboard*.test.ts`, `test/unit/core/usage-report*.test.ts`,
`docs/adr/**`
- `?sheet=usage` shows total, today and cache hit rate, cost by class with a share
  bar, and cost by model and effort with median context and recaches, for a window
  chosen by a `since` link set (7, 30 days), defaulting to 7.
- The report is built on demand, cached for 60 seconds, never run on the 2 s poll,
  and the screen states its age; a failure to read transcripts is an `.error` in
  the region, not a broken page.
- Unpriced models are named in an `.error` block, as `pup usage` reports them.
- Only aggregates reach the page: no transcript text, prompt, tool argument or path
  outside the project; a planted transcript line holding markup appears nowhere.
- The Home Project figure *spend today* reads the same cached report.
- A decision amends 91 (what the page shows is no longer one snapshot).
- The figures agree with `pup usage --json` for the same window, asserted in a test.

### 8. Projects

Scope-in: `src/core/web-dashboard-projects*.service.ts`, `src/core/project-registry*.service.ts`,
`src/core/web-dashboard.service.ts`, `src/core/web-dashboard-sheet.utils.ts`,
`test/unit/core/web-dashboard*.test.ts`, `docs/adr/**`
- `?sheet=projects` lists each registered project with needs-you count, running,
  open PRs and open debt, a dormant one as such and one whose conductor is out of
  reach flagged `bad`, as in the mockup; the current project is marked.
- Each project's store is read read-only, without its lock, and one unreadable
  store is an `.error` row that does not hide the others.
- Nothing from a project but name, state and counts reaches the page; no link and
  no button carries a token or acts on another project; the page tells the operator
  to run `pup --project <id> dashboard`.
- A dormant project is hidden unless the page's *show dormant* link is followed, as
  `pup project list` does.
- A decision amends 91 (the page's reach beyond one project's store, read-only).

## Risks

- **Slice 2 touches the heart of the stream.** Mitigation: it ships alone, with
  Home still the old Overview, and its tests pin the isolation and held-region
  rules before any screen depends on them.
- **Region reconciliation by key can hide a bug as a stale card.** Mitigation: the
  `held` chip, and a hash in each region's `data-version` that a test compares with
  the server's.
- **Usage scanning is slow.** Mitigation: on-demand, cached 60 s, never on the poll.
- **The unlocked cross-project read.** Mitigation: read-only, counts only, per-row
  errors; open question 2 asks whether it is worth having at all.
- **Eight slices rewrite most dashboard tests' markup assertions.** Mitigation: each
  slice keeps content assertions and changes only markup ones, stated in its
  criteria.

## Open questions for the operator

1. **Home label and URL.** Rename Overview to Home and break `?sheet=overview` and
   `?sheet=tasks` (my recommendation: yes, the url carries a per-run token and no
   one bookmarks it), or keep the old names as aliases?
2. **Projects across stores.** Is a read-only fleet screen worth reading other
   projects' stores from one project's dashboard? I recommend yes, counts only. The
   alternative is to drop slice 8 and leave fleet view to `pup status`.
3. **Review diffstat source.** Does core already have a function that gives a
   branch's changed paths and counts without reading contents, or should slice 5
   add one that shells out to `git diff --numstat`? I did not find one; the gate
   service's flags may already hold the figures.
4. **Usage window and cost honesty.** Costs are estimates from a price table, and an
   unpriced model is counted but not costed. Is that acceptable on a screen the
   operator may read as a bill, or should the figures say *estimate* beside every
   dollar sign?
5. **Land enabling.** Home enables Land when the server judges the PR merged. Today
   that is the target branch not yet holding the pinned commit. Do you want the page
   to ask GitHub whether the PR is merged, which is a network call decision 91
   avoids, or keep today's local check and let the operator press Land early?
6. **Keyboard model.** Are `g`-prefixed navigation and `j`/`k` wanted, or is the
   page mouse and tab driven for you? They cost about 40 lines and can be cut from
   slice 1.
7. **Notifications.** The tab title carries the needs-me count and one polite
   announcer speaks new needs. Do you also want a browser notification or a sound
   when a question arrives? I left both out, since each needs a permission prompt
   and a sound is hard to keep from being annoying.
8. **ADR bookkeeping.** Slices 1, 2, 4, 7 and 8 each write a decision amending
   decisions 91 or 98, which puts `docs/adr/**` in their scope. Do you prefer that,
   or one consolidated amendment written once by you or the conductor before slice 1
   starts?

## Decided by the operator (2026-11-23)

1. **Home label and URL.** Rename Overview to Home. `?sheet=overview` and `?sheet=tasks` stop working, with no aliases.
2. **Projects across stores.** Keep slice 8: a read-only fleet screen that reads other projects' stores for counts only.
3. **Cost honesty.** The word *estimate* sits beside every dollar figure on the Usage screen. An unpriced model is counted and not costed.
4. **ADR bookkeeping.** One consolidated decision amends 91 and 98, written once before slice 1 as an operator PR. The slices do not carry `docs/adr/**` in their scope.
5. **Defaults taken.** The review diffstat is a new function over `git diff --numstat`. Land enables on today's local merged check, with no GitHub call. The `g` and `j`/`k` keys stay in slice 1. There are no browser notifications and no sound.
