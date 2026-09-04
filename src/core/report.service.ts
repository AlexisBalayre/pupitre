import type { Database } from 'better-sqlite3';

import { type BaselineHistoryRow, listBaselineHistory } from './baseline-history.repository.js';
import { listDecisionRecords } from './decision-record.repository.js';
import { listLedgerEntries } from './ledger.repository.js';
import { PAGE_SHELL_CSS, PAGE_SHELL_JS } from './page-shell.constants.js';
import { PAGE_THEME_CSS } from './page-theme.constants.js';
import { projectId } from './paths.utils.js';
import {
  asStageArray,
  asStringArray,
  decisionRecordDatum,
  displayText,
  parseJsonOr,
  toIsoUtc,
} from './report-data.utils.js';
import {
  listBacklogTasks,
  listEvents,
  listSessions,
  listTasks,
  type SessionRow,
} from './session.repository.js';
import { dossierFileName } from './session-dossier.service.js';
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
    // Oldest first, the order `pup plan` lists them in: the backlog is a queue,
    // and the thing waiting longest is the one to answer for (decision 41).
    backlog: listBacklogTasks(db, pid).map((task) => {
      const spec = parseJsonOr<Partial<TaskSpec>>(task.spec, {});
      return {
        id: displayText(task.id),
        goal: typeof spec.goal === 'string' ? displayText(spec.goal) : '',
        scopeIn: asStringArray(spec.scopeIn).map(displayText),
        scopeOut: asStringArray(spec.scopeOut).map(displayText),
        origin: displayText(task.origin),
        createdAt: toIsoUtc(task.created_at),
      };
    }),
    // Newest first: the latest session is what the reader came for. A session
    // whose task row is missing still renders (the client shows its no-goal
    // copy) — vanishing without trace would be the wrong failure mode.
    sessions: listSessions(db)
      .reverse()
      .map((session) => {
        const task = tasks.get(session.task_id);
        return sessionDatum(db, session, task ? parseJsonOr<Partial<TaskSpec>>(task.spec, {}) : {});
      }),
    // Oldest first (trend order); captured_at is already ISO UTC, see toIsoUtc.
    baselines: listBaselineHistory(db, pid).map((row: BaselineHistoryRow) => {
      const debt =
        row.debt === null ? undefined : parseJsonOr<DebtBaseline | undefined>(row.debt, undefined);
      return {
        capturedAt: row.captured_at,
        duplicatedLines: debt?.duplicatedLines ?? null,
        coverageRatio: debt?.coverageRatio ?? null,
      };
    }),
    debt: listLedgerEntries(db, pid).map((entry) => ({
      id: entry.id,
      description: displayText(entry.description),
      reason: displayText(entry.reason),
      acceptedBy: displayText(entry.accepted_by),
      reviewBy: displayText(entry.review_by),
      createdAt: toIsoUtc(entry.created_at),
    })),
    decisions: listDecisionRecords(db).map((record) => ({
      ...decisionRecordDatum(record),
      sessionId: displayText(record.session_id),
    })),
  };
  // `<` escaped so a goal or summary containing `</script>` cannot break out of
  // the data block.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  // Function replacer: a string replacement would have its $-patterns ($&, $',
  // $\`) expanded, splicing raw template text — including a real </script> —
  // into the escaped data block.
  return HTML_TEMPLATE.replace('__PUP_REPORT_DATA__', () => json);
}

function sessionDatum(db: Database, session: SessionRow, spec: Partial<TaskSpec>) {
  // Newest first, so `find` returns the latest matching event.
  const events = listEvents(db, session.id).reverse();
  const done = events.find((event) => event.type === 'session_done');
  const doneSummary = done ? parseJsonOr<{ summary?: unknown }>(done.payload, {}).summary : null;
  // Every state transition logs a gate_result event; only real gate runs carry
  // a report payload (same filter as review.service's lastGateReport).
  const lastGate = events
    .filter((event) => event.type === 'gate_result')
    .map((event) => parseJsonOr<{ report?: GateReport }>(event.payload, {}).report)
    .find((report) => report !== undefined);
  return {
    id: displayText(session.id),
    state: displayText(session.state),
    // null for an id outside the dossier allowlist — the index renders the id
    // as plain text instead of a dead (or hostile) link.
    dossierFile: dossierFileName(session.id),
    branch: displayText(session.branch),
    createdAt: toIsoUtc(session.created_at),
    rejectCount: session.reject_count,
    goal: typeof spec.goal === 'string' ? displayText(spec.goal) : '',
    scopeIn: asStringArray(spec.scopeIn).map(displayText),
    scopeOut: asStringArray(spec.scopeOut).map(displayText),
    doneSummary: typeof doneSummary === 'string' ? displayText(doneSummary) : null,
    gateStages: asStageArray(lastGate?.stages),
  };
}

const HTML_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pup report</title>
<style>
${PAGE_THEME_CSS}
${PAGE_SHELL_CSS}
  article.session {
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    padding: 12px 14px; margin-bottom: 10px;
  }
  .sid { font-weight: 600; }
  .origin { color: var(--muted); font-size: 12px; }
  .sid a { color: inherit; text-decoration: none; border-bottom: 1px solid var(--baseline); }
  .sid a:hover { border-bottom-color: var(--ink-2); }
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
  .scope code {
    background: var(--page); border: 1px solid var(--grid); border-radius: 4px;
    padding: 0 5px; font-size: 11px; color: var(--ink-2);
  }
  .outcome { margin-top: 8px; font-size: 12px; color: var(--ink-2); max-width: 65ch; }
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
  .entry .desc { margin-top: 2px; white-space: pre-wrap; max-width: 65ch; }
  .entry .terms { margin-top: 2px; color: var(--ink-2); font-size: 12px; white-space: pre-wrap; max-width: 65ch; }
</style>
</head>
<body>
<header><h1>pup report</h1><span class="repo" id="repo"></span></header>
<main>
  <section>
    <h2>Backlog</h2>
    <div id="backlog-list"></div>
  </section>
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

${PAGE_SHELL_JS}

  // Backlog — intent that has not run yet, oldest first. Deliberately above
  // the sessions: a report read to decide what to do next is answered here.
  const backlog = document.getElementById('backlog-list');
  if (!data.backlog.length) hint(backlog, 'Nothing planned.');
  for (const task of data.backlog) {
    const art = el('article', 'session');
    art.innerHTML = '<div class="meta"><span class="state"></span><span class="sid"></span>' +
      '<span class="when"></span><span class="origin"></span></div>';
    stateChip(art.querySelector('.state'), 'planned');
    art.querySelector('.sid').textContent = task.id;
    art.querySelector('.when').textContent = when(task.createdAt);
    // Only when something other than the operator wrote it — the audit sweep is
    // the one such author today, and whose intent this is changes how it reads.
    if (task.origin && task.origin !== 'human') {
      art.querySelector('.origin').textContent = 'from ' + task.origin;
    }
    appendGoal(art, task.goal);
    appendScope(art, task);
    backlog.appendChild(art);
  }

  // Sessions — newest first, each with the intent that launched it.
  const sessions = document.getElementById('session-list');
  if (!data.sessions.length) hint(sessions, 'No sessions recorded yet.');
  for (const s of data.sessions) {
    const art = el('article', 'session');
    art.innerHTML = '<div class="meta"><span class="state"></span><span class="sid"></span>' +
      '<span class="branch"></span><span class="when"></span><span class="rejects"></span></div>';
    stateChip(art.querySelector('.state'), s.state);
    // The dossier link is service-built from a closed charset (dossierFileName);
    // a session whose id failed that allowlist stays plain text.
    if (s.dossierFile) {
      const link = document.createElement('a');
      link.href = s.dossierFile;
      link.textContent = s.id;
      art.querySelector('.sid').appendChild(link);
    } else {
      art.querySelector('.sid').textContent = s.id;
    }
    art.querySelector('.branch').textContent = s.branch;
    art.querySelector('.when').textContent = when(s.createdAt);
    if (s.rejectCount > 0) {
      art.querySelector('.rejects').textContent =
        s.rejectCount + (s.rejectCount === 1 ? ' rejection' : ' rejections');
    }
    appendGoal(art, s.goal);
    appendScope(art, s);
    const outcome = el('div', 'outcome');
    if (s.doneSummary) {
      const done = el('div', 'done');
      done.textContent = 'done: ' + s.doneSummary;
      outcome.appendChild(done);
    }
    if (s.gateStages.length) {
      const gate = el('div', 'gate');
      gate.textContent = 'last gate: ' + s.gateStages.map(stageText).join(' \\u00b7 ');
      outcome.appendChild(gate);
    }
    if (outcome.childNodes.length) art.appendChild(outcome);
    sessions.appendChild(art);
  }

  // The scope chips a planned task and a running session both carry — the same
  // globs mean the same thing before and after a session exists.
  function appendScope(parent, spec) {
    if (!spec.scopeIn.length && !spec.scopeOut.length) return;
    const scope = el('div', 'scope');
    const k = el('span', 'k');
    k.textContent = 'scope';
    scope.appendChild(k);
    for (const glob of spec.scopeIn) {
      const c = el('code');
      c.textContent = glob;
      scope.appendChild(c);
    }
    for (const glob of spec.scopeOut) {
      const c = el('code');
      c.textContent = 'not ' + glob;
      scope.appendChild(c);
    }
    parent.appendChild(scope);
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
    decisionFields(div, record);
    decisions.appendChild(div);
  }
})();
</script>
</body>
</html>
`;
