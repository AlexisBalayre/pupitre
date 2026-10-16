import { sanitizeReason } from '../adapters/capability.utils.js';
import { PR_URL } from './dashboard.service.js';
import { PAGE_SHELL_CSS } from './page-shell.constants.js';
import { PAGE_THEME_CSS } from './page-theme.constants.js';
import type {
  DashboardNeed,
  DashboardSession,
  DashboardSnapshot,
} from './types/dashboard.types.js';

/** One open ledger entry as the page lists it, every field already through `sanitizeReason`. */
interface WebDebtEntry {
  id: string;
  description: string;
  acceptedBy: string;
  reviewBy: string;
}

/** What one render of the board reads: the snapshot `pup status` prints, and what it leaves to `pup debt`. */
export interface WebDashboardView {
  snapshot: DashboardSnapshot;
  needs: DashboardNeed[];
  openDebt: WebDebtEntry[];
  /** Fix rounds re-gated per session with an open PR, keyed by session id (decision 86). */
  fixRounds: Map<string, number>;
}

/**
 * Every store-read string reaches the page through this (decision 91): the
 * snapshot already scrubbed what a terminal obeys (decision 29), and markup is
 * the browser's equivalent. Quotes too, since the PR url lands in an attribute.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escaped text, or a link when it is a pull request's url and nothing else (decisions 83, 91). */
function textOrPrLink(text: string): string {
  if (!PR_URL.test(text)) return `<code>${escapeHtml(text)}</code>`;
  // `noreferrer`: the page's own url carries the run token.
  return `<a href="${escapeHtml(text)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
}

/** The order the sessions' states are listed in: what has stopped first, finished work last. */
const STATE_ORDER = ['blocked', 'running', 'awaiting-review', 'queued', 'rejected'];
const UNMINTED_LABEL = '(unminted session id)';

/**
 * The board — everything inside `<main>` — as one string. The page carries it
 * first, and the event stream carries every later one whole, so the two are a
 * single render and a reader never sees a page the stream would draw otherwise.
 * Nothing in it is time-relative beyond what the snapshot holds, so an unchanged
 * store renders the same string and the stream stays quiet.
 */
export function renderDashboardBody(view: WebDashboardView): string {
  return [
    needsSection(view.needs),
    conductorSection(view.snapshot),
    sessionsSection(view),
    pullRequestsSection(view),
    plannedSection(view.snapshot),
    debtSection(view),
  ].join('\n');
}

function section(title: string, body: string): string {
  return `<section><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

function hint(text: string): string {
  return `<p class="hint">${escapeHtml(text)}</p>`;
}

function needsSection(needs: DashboardNeed[]): string {
  if (needs.length === 0) return section('Needs you', hint('Nothing waits on you.'));
  const items = needs.map(
    (need) =>
      `<li class="need need-${escapeHtml(need.kind)}"><span class="sid">${escapeHtml(need.label)}</span> ` +
      `<span class="reason">${escapeHtml(need.reason)}</span>` +
      `<div class="answer">${textOrPrLink(need.answer)}</div></li>`,
  );
  return section('Needs you', `<ul class="rows">${items.join('')}</ul>`);
}

function conductorSection(snapshot: DashboardSnapshot): string {
  const { conductor } = snapshot;
  const body = conductor.running
    ? `<p>running <span class="hint">attach:</span> <code>${escapeHtml(conductor.attachCommand)}</code></p>`
    : hint('not running — `pup conductor start` starts it');
  return section('Conductor', body);
}

function sessionsSection(view: WebDashboardView): string {
  const live = view.snapshot.sessions.filter((s) => s.state !== 'merged' && s.state !== 'killed');
  if (live.length === 0) return section('Sessions', hint('Nothing running.'));
  const states = [
    ...STATE_ORDER.filter((state) => live.some((s) => s.state === state)),
    ...new Set(live.map((s) => s.state).filter((state) => !STATE_ORDER.includes(state))),
  ];
  const groups = states.map((state) => {
    const rows = live.filter((s) => s.state === state).map((s) => sessionRow(s, view.openDebt));
    return `<h3 class="state-group">${escapeHtml(state)} <span class="hint">${rows.length}</span></h3><ul class="rows">${rows.join('')}</ul>`;
  });
  return section('Sessions', groups.join(''));
}

function sessionRow(session: DashboardSession, openDebt: WebDebtEntry[]): string {
  const facts = [
    session.question === undefined ? '' : `question: ${session.question}`,
    activityText(session),
    session.rejectCount > 0 ? `${session.rejectCount} rejections` : '',
    session.contextTokens === undefined ? '' : `ctx ~${Math.round(session.contextTokens / 1000)}k`,
    steerText(session),
    gateText(session),
  ].filter(Boolean);
  return (
    `<li class="session"><div class="meta"><span class="sid">${escapeHtml(labelOf(session))}</span>` +
    `<span class="branch">${escapeHtml(session.branch)}</span></div>` +
    `<div class="goal">${escapeHtml(session.goal || '(no goal recorded)')}</div>` +
    facts.map((fact) => `<div class="fact">${escapeHtml(fact)}</div>`).join('') +
    debtOf(session, openDebt) +
    '</li>'
  );
}

function labelOf(session: DashboardSession): string {
  return session.isMintedId ? session.id : UNMINTED_LABEL;
}

function activityText(session: DashboardSession): string {
  if (session.stalledAgeMs !== undefined) return 'stalled — see Needs you';
  if (session.activity?.kind === 'awaiting-input') {
    const detail = sanitizeReason(session.activity.detail ?? '');
    return `waiting on input${detail ? ` (${detail})` : ''}`;
  }
  if (session.activity?.kind === 'idle') return 'idle (turn ended, no done signal)';
  return '';
}

function steerText(session: DashboardSession): string {
  const steer = session.lastSteer;
  if (!steer) return '';
  return `last steer: ${steer.kind ?? 'sent'}${steer.by ? ` by ${steer.by}` : ''} at ${steer.at}`;
}

function gateText(session: DashboardSession): string {
  const gate = session.lastGate;
  if (!gate) return '';
  const verdict = gate.passed
    ? 'passed'
    : `failed${gate.failedStage ? ` at ${gate.failedStage}` : ''}`;
  return `last gate: ${verdict} at ${gate.at}`;
}

/**
 * The open entries this session filed: every flag description the gate files
 * ends with ` session <id>` (decision 86). An id outside the minted shape is
 * matched against nothing, like the commands it gets none of.
 */
function debtOf(session: DashboardSession, openDebt: WebDebtEntry[]): string {
  if (!session.isMintedId) return '';
  const own = openDebt.filter((entry) => entry.description.endsWith(` session ${session.id}`));
  return own
    .map(
      (entry) =>
        `<div class="fact debt">debt #${escapeHtml(entry.id)}: ${escapeHtml(entry.description)}</div>`,
    )
    .join('');
}

function pullRequestsSection(view: WebDashboardView): string {
  const open = view.snapshot.sessions.filter((s) => s.openPr !== undefined);
  if (open.length === 0) return section('Open pull requests', hint('No PR waits to land.'));
  const rows = open.map((session) => {
    const url = session.openPr?.url;
    const link =
      url === undefined
        ? `<code>${escapeHtml('(PR url outside the pull-request shape; inspect the store)')}</code>`
        : textOrPrLink(url);
    return (
      `<li class="session"><div class="meta"><span class="sid">${escapeHtml(labelOf(session))}</span>${link}</div>` +
      `<div class="goal">${escapeHtml(session.goal || '(no goal recorded)')}</div>` +
      `<div class="fact">${escapeHtml(reviewState(session, view.fixRounds.get(session.id)))}</div>` +
      debtOf(session, view.openDebt) +
      '</li>'
    );
  });
  return section('Open pull requests', `<ul class="rows">${rows.join('')}</ul>`);
}

/**
 * The PR's CI review state as the store knows it: how many fix rounds were
 * re-gated, and the newest gate's verdict, which on a refused re-gate is what
 * says the PR still vouches for the earlier pin (decision 86). What CI itself
 * said is on the PR until `pup fix` reads the bot's threads (decision 90).
 */
function reviewState(session: DashboardSession, rounds: number | undefined): string {
  const regated =
    rounds === undefined
      ? 'fix rounds unknown'
      : rounds === 0
        ? 'gated once, no fix round re-gated yet'
        : `re-gated after ${rounds} fix ${rounds === 1 ? 'round' : 'rounds'}`;
  const gate = gateText(session);
  return `CI review: ${regated}${gate ? `; ${gate}` : ''}`;
}

function plannedSection(snapshot: DashboardSnapshot): string {
  if (snapshot.backlog.length === 0) return section('Planned', hint('Nothing planned.'));
  const rows = snapshot.backlog.map(
    (task) =>
      `<li class="session"><div class="meta"><span class="sid">${escapeHtml(task.id)}</span>` +
      `${task.origin === 'human' ? '' : `<span class="branch">from ${escapeHtml(task.origin)}</span>`}</div>` +
      `<div class="goal">${escapeHtml(task.goal || '(no goal recorded)')}</div></li>`,
  );
  return section('Planned', `<ul class="rows">${rows.join('')}</ul>`);
}

function debtSection(view: WebDashboardView): string {
  if (view.openDebt.length === 0) return section('Open debt', hint('No open debt.'));
  const overdue = new Set(view.snapshot.overdueDebt.map((entry) => entry.id));
  const rows = view.openDebt.map(
    (entry) =>
      `<li class="entry${overdue.has(entry.id) ? ' overdue' : ''}"><div class="meta"><span class="sid">#${escapeHtml(entry.id)}</span>` +
      `${overdue.has(entry.id) ? '<span class="state state-blocked">overdue</span>' : ''}</div>` +
      `<div class="desc">${escapeHtml(entry.description)}</div>` +
      `<div class="fact">accepted by ${escapeHtml(entry.acceptedBy)}, review by ${escapeHtml(entry.reviewBy)}</div></li>`,
  );
  return section('Open debt', `<ul class="rows">${rows.join('')}</ul>`);
}

/**
 * The page around a board. The script and the style carry the response's
 * nonce, the only source the CSP admits for either (decision 91); the script
 * only swaps in the board the stream sends, which the server rendered and
 * escaped, and reports whether the stream is up.
 */
export function renderDashboardPage(repoPath: string, body: string, nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>pup dashboard</title>
<style nonce="${nonce}">
${PAGE_THEME_CSS}
${PAGE_SHELL_CSS}
  body { overflow-wrap: anywhere; }
  header .live { margin-left: auto; color: var(--muted); font-size: 12px; }
  ul.rows { list-style: none; padding: 0; }
  ul.rows > li {
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    padding: 10px 12px; margin-bottom: 8px;
  }
  h3.state-group { font-size: 12px; font-weight: 600; margin: 14px 0 6px; color: var(--ink-2); }
  .sid { font-weight: 600; }
  .need .reason { color: var(--ink-2); }
  .need-question, .need-blocked, .need-stalled { border-left: 3px solid var(--debt-2); }
  .answer, .goal, .fact, .desc { margin-top: 4px; }
  .fact { color: var(--ink-2); font-size: 12px; }
  .debt { color: var(--debt-3); }
  code {
    font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
    background: var(--page); border: 1px solid var(--grid); border-radius: 4px; padding: 0 4px;
  }
  a { color: var(--debt-2); }
  @media (max-width: 480px) { header, main { padding-left: 12px; padding-right: 12px; } }
</style>
</head>
<body>
<header><h1>pup dashboard</h1><span class="repo">${escapeHtml(repoPath)}</span><span class="live" id="live">connecting…</span></header>
<main id="board">
${body}
</main>
<script nonce="${nonce}">
(() => {
  const board = document.getElementById('board');
  const live = document.getElementById('live');
  const stream = new EventSource('events' + location.search);
  stream.onopen = () => { live.textContent = 'live'; };
  stream.onerror = () => { live.textContent = 'reconnecting…'; };
  stream.onmessage = (event) => { board.innerHTML = JSON.parse(event.data); };
})();
</script>
</body>
</html>
`;
}
