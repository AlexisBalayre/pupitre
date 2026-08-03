import type { Database } from 'better-sqlite3';

import { type BaselineHistoryRow, listBaselineHistory } from './baseline-history.repository.js';
import { listDecisionRecords } from './decision-record.repository.js';
import { listLedgerEntries } from './ledger.repository.js';
import { projectId } from './paths.utils.js';
import { listEvents, listSessions, listTasks, type SessionRow } from './session.repository.js';
import type { DebtBaseline } from './types/init.types.js';
import type { GateReport } from './types/merge-gate.types.js';
import type { TaskSpec } from './types/profile.types.js';

/**
 * `pup report --open` (docs/02): the index page of the project report — one
 * self-contained local HTML file, inline CSS and vanilla JS, no CDN, so it
 * opens offline and never phones home. It renders only what the store already
 * holds (sessions with their task intent, baseline drift, open debt, decision
 * records); anything needing live computation stays with `pup map`.
 */
export function renderReportHtml(db: Database, repoPath: string): string {
  const pid = projectId(repoPath);
  const tasks = new Map(listTasks(db, pid).map((task) => [task.id, task]));
  const data = {
    repoPath,
    // Newest first: the latest session is what the reader came for.
    sessions: listSessions(db)
      .reverse()
      .flatMap((session) => {
        const task = tasks.get(session.task_id);
        return task ? [sessionDatum(db, session, JSON.parse(task.spec) as Partial<TaskSpec>)] : [];
      }),
    // Oldest first (trend order); captured_at is already ISO UTC, see toIsoUtc.
    baselines: listBaselineHistory(db, pid).map((row: BaselineHistoryRow) => {
      const debt = row.debt === null ? undefined : (JSON.parse(row.debt) as DebtBaseline);
      return {
        capturedAt: row.captured_at,
        duplicatedLines: debt?.duplicatedLines ?? null,
        coverageRatio: debt?.coverageRatio ?? null,
      };
    }),
    debt: listLedgerEntries(db, pid).map((entry) => ({
      id: entry.id,
      description: entry.description,
      reason: entry.reason,
      acceptedBy: entry.accepted_by,
      reviewBy: entry.review_by,
      createdAt: toIsoUtc(entry.created_at),
    })),
    decisions: listDecisionRecords(db).map((record) => ({
      id: record.id,
      sessionId: record.session_id,
      summary: record.summary,
      alternatives: record.alternatives,
      conventions: record.conventions,
      files: JSON.parse(record.files) as string[],
      createdAt: toIsoUtc(record.created_at),
    })),
  };
  // `<` escaped so a goal or summary containing `</script>` cannot break out of
  // the data block.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return HTML_TEMPLATE.replace('__PUP_REPORT_DATA__', json);
}

/**
 * SQLite's `datetime('now')` columns hold UTC as `2026-08-03 12:36:05` — no
 * zone marker, which JavaScript's Date would parse as LOCAL time and shift by
 * the viewer's offset. Rewrite that form to ISO UTC (`2026-08-03T12:36:05Z`)
 * so every timestamp in the data block means the same instant.
 * `baseline_history.captured_at` is already a real ISO string with a Z and
 * passes through unchanged.
 */
function toIsoUtc(timestamp: string): string {
  return /^\d{4}-\d{2}-\d{2} /.test(timestamp) ? `${timestamp.replace(' ', 'T')}Z` : timestamp;
}

function sessionDatum(db: Database, session: SessionRow, spec: Partial<TaskSpec>) {
  // Newest first, so `find` returns the latest matching event.
  const events = listEvents(db, session.id).reverse();
  const done = events.find((event) => event.type === 'session_done');
  // Every state transition logs a gate_result event; only real gate runs carry
  // a report payload (same filter as review.service's lastGateReport).
  const lastGate = events
    .filter((event) => event.type === 'gate_result')
    .map((event) => (JSON.parse(event.payload) as { report?: GateReport }).report)
    .find((report) => report !== undefined);
  return {
    id: session.id,
    state: session.state,
    branch: session.branch,
    createdAt: toIsoUtc(session.created_at),
    rejectCount: session.reject_count,
    goal: spec.goal ?? '',
    scopeIn: spec.scopeIn ?? [],
    scopeOut: spec.scopeOut ?? [],
    doneSummary: done ? ((JSON.parse(done.payload) as { summary?: string }).summary ?? null) : null,
    gateStages:
      lastGate?.stages.map((stage) => ({
        stage: stage.stage,
        status: stage.status,
        detail: stage.detail ?? null,
      })) ?? [],
  };
}

const HTML_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pup report</title>
<style>
  :root {
    --surface: #fcfcfb; --page: #f9f9f7;
    --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
    --grid: #e1e0d9; --baseline: #c3c2b7; --border: rgba(11,11,11,0.10);
    --debt-0: #86b6ef; --debt-1: #3987e5; --debt-2: #1c5cab; --debt-3: #0d366b;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface: #1a1a19; --page: #0d0d0d;
      --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
      --grid: #2c2c2a; --baseline: #383835; --border: rgba(255,255,255,0.10);
      --debt-0: #184f95; --debt-1: #256abf; --debt-2: #3987e5; --debt-3: #6da7ec;
    }
  }
  * { margin: 0; box-sizing: border-box; }
  body {
    font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--page); color: var(--ink);
  }
  header {
    padding: 14px 20px; border-bottom: 1px solid var(--grid);
    display: flex; align-items: baseline; gap: 12px;
  }
  header h1 { font-size: 14px; font-weight: 600; }
  header .repo { color: var(--ink-2); font-size: 12px; }
  main { max-width: 760px; margin: 0 auto; padding: 8px 20px 72px; }
  section { margin-top: 28px; }
  section > h2 {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--muted); margin-bottom: 10px; font-weight: 600;
  }
  .hint { color: var(--muted); }
  article.session {
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    padding: 12px 14px; margin-bottom: 10px;
  }
  .meta { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .state {
    border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px;
    font-size: 11px; color: var(--ink-2); white-space: nowrap;
  }
  .state-running { background: var(--debt-1); border-color: transparent; color: #fff; }
  .state-blocked { background: var(--ink); border-color: transparent; color: var(--page); }
  .sid { font-weight: 600; }
  .branch, .when { color: var(--muted); font-size: 12px; }
  .rejects { color: var(--ink-2); font-size: 12px; }
  .goal-body { margin-top: 8px; white-space: pre-wrap; max-width: 65ch; }
  details.goal { margin-top: 8px; }
  details.goal summary { cursor: pointer; }
  details.goal summary .first {
    display: inline-block; max-width: calc(100% - 24px); overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom;
  }
  details.goal[open] summary .first { display: none; }
  details.goal .goal-body { margin-top: 6px; }
  .scope { margin-top: 8px; display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
  .scope .k, .field .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  .scope code {
    background: var(--page); border: 1px solid var(--grid); border-radius: 4px;
    padding: 0 5px; font-size: 11px; color: var(--ink-2);
  }
  .outcome { margin-top: 8px; font-size: 12px; color: var(--ink-2); }
  .outcome .done { color: var(--ink); white-space: pre-wrap; }
  #drift { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
  #drift-caption { font-size: 12px; margin-bottom: 8px; }
  .metric {
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    padding: 12px 14px;
  }
  .metric .k {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted);
  }
  .metric .value { font-size: 20px; font-weight: 600; margin: 4px 0 8px; }
  .metric svg { width: 100%; height: auto; display: block; }
  .metric .range { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin-top: 4px; }
  .spark-line { stroke: var(--debt-1); stroke-width: 2; fill: none; }
  .spark-dot { fill: var(--debt-2); stroke: var(--surface); stroke-width: 1.5; }
  .spark-base { stroke: var(--grid); stroke-width: 1; }
  .entry { border-top: 1px solid var(--grid); padding: 10px 0; }
  .entry .when { color: var(--muted); font-size: 11px; }
  .entry .desc { margin-top: 2px; white-space: pre-wrap; max-width: 65ch; }
  .entry .terms, .entry .field { margin-top: 2px; color: var(--ink-2); font-size: 12px; white-space: pre-wrap; }
</style>
</head>
<body>
<header><h1>pup report</h1><span class="repo" id="repo"></span></header>
<main>
  <section>
    <h2>Sessions</h2>
    <div id="session-list"></div>
  </section>
  <section>
    <h2>Baseline &amp; drift</h2>
    <p class="hint" id="drift-caption"></p>
    <div id="drift"></div>
  </section>
  <section>
    <h2>Open debt</h2>
    <div id="debt-list"></div>
  </section>
  <section>
    <h2>Decision records</h2>
    <div id="decision-list"></div>
  </section>
</main>
<script id="pup-report-data" type="application/json">__PUP_REPORT_DATA__</script>
<script>
(() => {
  const data = JSON.parse(document.getElementById('pup-report-data').textContent);
  document.getElementById('repo').textContent = data.repoPath;

  const el = (tag, cls) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  };
  const hint = (parent, text) => {
    const p = el('p', 'hint');
    p.textContent = text;
    parent.appendChild(p);
  };
  const when = (iso) =>
    new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  // Sessions — newest first, each with the intent that launched it.
  const sessions = document.getElementById('session-list');
  if (!data.sessions.length) hint(sessions, 'No sessions recorded yet.');
  for (const s of data.sessions) {
    const art = el('article', 'session');
    art.innerHTML = '<div class="meta"><span class="state"></span><span class="sid"></span>' +
      '<span class="branch"></span><span class="when"></span><span class="rejects"></span></div>';
    const state = art.querySelector('.state');
    state.textContent = s.state;
    state.classList.add('state-' + s.state);
    art.querySelector('.sid').textContent = s.id;
    art.querySelector('.branch').textContent = s.branch;
    art.querySelector('.when').textContent = when(s.createdAt);
    if (s.rejectCount > 0) {
      art.querySelector('.rejects').textContent =
        s.rejectCount + (s.rejectCount === 1 ? ' rejection' : ' rejections');
    }
    appendGoal(art, s.goal);
    if (s.scopeIn.length || s.scopeOut.length) {
      const scope = el('div', 'scope');
      const k = el('span', 'k');
      k.textContent = 'scope';
      scope.appendChild(k);
      for (const glob of s.scopeIn) {
        const c = el('code');
        c.textContent = glob;
        scope.appendChild(c);
      }
      for (const glob of s.scopeOut) {
        const c = el('code');
        c.textContent = 'not ' + glob;
        scope.appendChild(c);
      }
      art.appendChild(scope);
    }
    const outcome = el('div', 'outcome');
    if (s.doneSummary) {
      const done = el('div', 'done');
      done.textContent = 'done: ' + s.doneSummary;
      outcome.appendChild(done);
    }
    if (s.gateStages.length) {
      const gate = el('div', 'gate');
      gate.textContent = 'last gate: ' + s.gateStages
        .map((st) => st.stage + ' ' + st.status.toUpperCase() + (st.detail ? ' \\u2014 ' + st.detail : ''))
        .join(' \\u00b7 ');
      outcome.appendChild(gate);
    }
    if (outcome.childNodes.length) art.appendChild(outcome);
    sessions.appendChild(art);
  }

  // Goals run 400-1400 chars: short ones render in place, long ones get a
  // disclosure whose summary is the (ellipsized) opening line — never truncated
  // for real, the full text is one click away.
  function appendGoal(parent, goal) {
    const text = goal || '(no goal recorded)';
    if (text.length <= 200) {
      const div = el('div', 'goal-body');
      div.textContent = text;
      parent.appendChild(div);
      return;
    }
    const details = el('details', 'goal');
    const summary = el('summary');
    const first = el('span', 'first');
    first.textContent = text;
    summary.appendChild(first);
    const body = el('div', 'goal-body');
    body.textContent = text;
    details.appendChild(summary);
    details.appendChild(body);
    parent.appendChild(details);
  }

  // Baseline & drift — one small chart per metric (different units never share
  // an axis), x spaced by capture index so 2 points and 50 both read cleanly.
  const drift = document.getElementById('drift');
  if (!data.baselines.length) {
    hint(drift, 'No baseline captures yet.');
  } else {
    const first = data.baselines[0];
    const last = data.baselines[data.baselines.length - 1];
    document.getElementById('drift-caption').textContent =
      data.baselines.length === 1
        ? 'One capture, ' + when(first.capturedAt)
        : data.baselines.length + ' captures, ' + when(first.capturedAt) + ' \\u2192 ' + when(last.capturedAt);
    metricCard(drift, 'duplicated lines', (b) => b.duplicatedLines, (v) => String(v));
    metricCard(drift, 'coverage', (b) => b.coverageRatio, (v) => Math.round(v * 1000) / 10 + '%');
  }

  function metricCard(parent, label, pick, format) {
    const card = el('div', 'metric');
    card.innerHTML = '<div class="k"></div><div class="value"></div>';
    card.querySelector('.k').textContent = label;
    const points = data.baselines
      .map((b, i) => ({ i, v: pick(b), capturedAt: b.capturedAt }))
      .filter((p) => p.v !== null);
    if (!points.length) {
      card.querySelector('.value').textContent = '\\u2014';
      hint(card, 'not measured');
    } else {
      card.querySelector('.value').textContent = format(points[points.length - 1].v);
      card.appendChild(sparkline(points, data.baselines.length, format));
      const range = el('div', 'range');
      const lo = el('span');
      const hi = el('span');
      lo.textContent = 'min ' + format(Math.min(...points.map((p) => p.v)));
      hi.textContent = 'max ' + format(Math.max(...points.map((p) => p.v)));
      range.appendChild(lo);
      range.appendChild(hi);
      card.appendChild(range);
    }
    parent.appendChild(card);
  }

  function sparkline(points, captures, format) {
    const NS = 'http://www.w3.org/2000/svg';
    const W = 260, H = 64, PAD = 8;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('role', 'img');
    const min = Math.min(...points.map((p) => p.v));
    const max = Math.max(...points.map((p) => p.v));
    const x = (i) => (captures === 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (captures - 1));
    const y = (v) => (max === min ? H / 2 : H - PAD - ((v - min) / (max - min)) * (H - 2 * PAD));
    const base = document.createElementNS(NS, 'line');
    base.setAttribute('class', 'spark-base');
    base.setAttribute('x1', PAD); base.setAttribute('y1', H - PAD);
    base.setAttribute('x2', W - PAD); base.setAttribute('y2', H - PAD);
    svg.appendChild(base);
    if (points.length > 1) {
      const line = document.createElementNS(NS, 'polyline');
      line.setAttribute('class', 'spark-line');
      line.setAttribute('points', points.map((p) => x(p.i) + ',' + y(p.v)).join(' '));
      svg.appendChild(line);
    }
    // Dots only while they stay readable; the line alone carries a dense trend.
    if (points.length <= 40) {
      for (const p of points) {
        const dot = document.createElementNS(NS, 'circle');
        dot.setAttribute('class', 'spark-dot');
        dot.setAttribute('cx', x(p.i));
        dot.setAttribute('cy', y(p.v));
        dot.setAttribute('r', 3);
        const title = document.createElementNS(NS, 'title');
        title.textContent = format(p.v) + ' \\u00b7 ' + when(p.capturedAt);
        dot.appendChild(title);
        svg.appendChild(dot);
      }
    }
    return svg;
  }

  // Open debt — oldest first, the longest-held shortcut on top.
  const debt = document.getElementById('debt-list');
  if (!data.debt.length) hint(debt, 'No open debt.');
  for (const entry of data.debt) {
    const div = el('div', 'entry');
    div.innerHTML = '<div class="when"></div><div class="desc"></div><div class="terms"></div>';
    div.querySelector('.when').textContent =
      '#' + entry.id + ' \\u00b7 ' + when(entry.createdAt) + ' \\u00b7 accepted by ' + entry.acceptedBy;
    div.querySelector('.desc').textContent = entry.description;
    div.querySelector('.terms').textContent =
      'reason: ' + entry.reason + ' \\u00b7 review by: ' + entry.reviewBy;
    debt.appendChild(div);
  }

  // Decision records — newest first, the richest prose in the store.
  const decisions = document.getElementById('decision-list');
  if (!data.decisions.length) hint(decisions, 'No decision records yet.');
  for (const record of data.decisions) {
    const div = el('div', 'entry');
    div.innerHTML = '<div class="when"></div><div class="desc"></div>';
    div.querySelector('.when').textContent =
      '#' + record.id + ' \\u00b7 ' + when(record.createdAt) + ' \\u00b7 session ' + record.sessionId;
    div.querySelector('.desc').textContent = record.summary;
    if (record.alternatives) field(div, 'alternatives', record.alternatives);
    if (record.conventions) field(div, 'conventions', record.conventions);
    if (record.files.length) field(div, 'files', record.files.join(', '));
    decisions.appendChild(div);
  }

  function field(parent, key, value) {
    const div = el('div', 'field');
    const k = el('span', 'k');
    k.textContent = key + ': ';
    div.appendChild(k);
    div.appendChild(document.createTextNode(value));
    parent.appendChild(div);
  }
})();
</script>
</body>
</html>
`;
