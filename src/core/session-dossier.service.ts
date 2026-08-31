import type { Database } from 'better-sqlite3';

import { listDecisionRecords } from './decision-record.repository.js';
import { PAGE_THEME_CSS } from './page-theme.constants.js';
import { projectId } from './paths.utils.js';
import {
  asStageArray,
  asStringArray,
  displayText,
  parseJsonOr,
  toIsoUtc,
} from './report-data.utils.js';
import { type EventRow, listEvents, listTasks, type SessionRow } from './session.repository.js';
import type { GateReport } from './types/merge-gate.types.js';
import type { TaskSpec } from './types/profile.types.js';

/**
 * One session's dossier page — the report's per-session detail view
 * (docs/02): what was asked (the full task spec, acceptance included), what
 * the gate said (every event in order, every gate run with its stages — the
 * index shows only the last), what landed (the merge's files and PR), and
 * what was learned (the session's decision records). Same self-contained
 * rules as the index: inline CSS and vanilla JS, no CDN, opens offline.
 */
export function renderSessionDossierHtml(
  db: Database,
  repoPath: string,
  session: SessionRow,
): string {
  const task = listTasks(db, projectId(repoPath)).find((row) => row.id === session.task_id);
  const spec = task ? parseJsonOr<Partial<TaskSpec>>(task.spec, {}) : {};
  const events = listEvents(db, session.id);
  // Newest first, so `find` returns the latest merge — a respawned session can
  // in principle merge more than once, and the latest is what stands.
  const mergeEvent = [...events].reverse().find((event) => event.type === 'merge');
  const data = {
    repoPath,
    session: {
      id: displayText(session.id),
      state: displayText(session.state),
      branch: displayText(session.branch),
      createdAt: toIsoUtc(session.created_at),
      rejectCount: session.reject_count,
    },
    intent: {
      goal: typeof spec.goal === 'string' ? displayText(spec.goal) : '',
      scopeIn: asStringArray(spec.scopeIn).map(displayText),
      scopeOut: asStringArray(spec.scopeOut).map(displayText),
      acceptance: asStringArray(spec.acceptance).map(displayText),
    },
    timeline: events.map(timelineDatum),
    merge: mergeEvent ? mergeDatum(mergeEvent) : null,
    decisions: listDecisionRecords(db)
      .filter((record) => record.session_id === session.id)
      .map((record) => ({
        id: record.id,
        summary: displayText(record.summary),
        alternatives: record.alternatives === null ? null : displayText(record.alternatives),
        conventions: record.conventions === null ? null : displayText(record.conventions),
        files: asStringArray(parseJsonOr<unknown>(record.files, [])).map(displayText),
        createdAt: toIsoUtc(record.created_at),
      })),
  };
  // `<` escaped so agent-written prose containing `</script>` cannot break out
  // of the data block; function replacer so $-patterns in that prose are not
  // expanded into template text (both per report.service).
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return HTML_TEMPLATE.replace('__PUP_DOSSIER_DATA__', () => json);
}

/**
 * Session ids are pup-generated, but the store is session-writable, so an id
 * is untrusted as a path fragment. Only ids from this closed allowlist get a
 * dossier file (and a link from the index); anything else — separators, dots,
 * a hostile `../` — stays unlinked instead of escaping the project dir.
 */
export function dossierFileName(sessionId: string): string | null {
  return /^[A-Za-z0-9_-]{1,64}$/.test(sessionId) ? `session-${sessionId}.html` : null;
}

/**
 * Flatten one event into what the page shows: a title line, optional prose
 * body, and the gate stages or file list when the payload carries them. An
 * event type nothing special-cases still renders — type plus raw payload —
 * because dropping store rows silently is the wrong failure mode.
 */
function timelineDatum(event: EventRow) {
  const payload = parseJsonOr<Record<string, unknown>>(event.payload, {});
  const datum: {
    at: string;
    title: string;
    body: string | null;
    stages: { stage: string; status: string; detail: string | null }[];
    files: string[];
  } = {
    at: toIsoUtc(event.created_at),
    title: displayText(event.type),
    body: null,
    stages: [],
    files: [],
  };
  switch (event.type) {
    case 'gate_result': {
      const report = payload.report as Partial<GateReport> | undefined;
      datum.stages = asStageArray(report?.stages);
      if (payload.outcome === 'refused') datum.title = 'gate refused';
      else if (typeof payload.from === 'string' && typeof payload.to === 'string')
        datum.title = displayText(`${payload.from} → ${payload.to}`);
      else if (report) datum.title = report.passed ? 'gate passed' : 'gate failed';
      break;
    }
    case 'merge': {
      datum.title =
        typeof payload.target === 'string'
          ? displayText(`merged into ${payload.target}`)
          : 'merged';
      datum.files = asStringArray(payload.files).map(displayText);
      datum.body = safeHttpUrl(payload.prUrl);
      break;
    }
    case 'steer':
      datum.title =
        typeof payload.kind === 'string' ? displayText(`steer (${payload.kind})`) : 'steer';
      break;
    case 'session_done':
      datum.title = 'done';
      datum.body = typeof payload.summary === 'string' ? displayText(payload.summary) : null;
      break;
    case 'handoff_ready':
      datum.title = 'handoff ready';
      break;
    default:
      if (Object.keys(payload).length > 0) datum.body = displayText(JSON.stringify(payload));
  }
  return datum;
}

function mergeDatum(event: EventRow) {
  const payload = parseJsonOr<Record<string, unknown>>(event.payload, {});
  return {
    target: typeof payload.target === 'string' ? displayText(payload.target) : null,
    files: asStringArray(payload.files).map(displayText),
    prUrl: safeHttpUrl(payload.prUrl),
  };
}

/**
 * The PR URL comes from a store row a session wrote, and the page renders it
 * as a clickable href — validate it HERE, not in the page, so a `javascript:`
 * or `file:` scheme never reaches an anchor at all.
 */
function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const scheme = new URL(value).protocol;
    return scheme === 'http:' || scheme === 'https:' ? value : null;
  } catch {
    return null;
  }
}

const HTML_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pup session dossier</title>
<style>
${PAGE_THEME_CSS}
  * { margin: 0; box-sizing: border-box; }
  body {
    font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--page); color: var(--ink);
  }
  header {
    padding: 14px 20px; border-bottom: 1px solid var(--grid);
    display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
  }
  header a.back { color: var(--muted); text-decoration: none; }
  header a.back:hover { color: var(--ink-2); }
  header h1 { font-size: 14px; font-weight: 600; }
  header .repo { color: var(--ink-2); font-size: 12px; }
  main { max-width: 760px; margin: 0 auto; padding: 8px 20px 72px; }
  section { margin-top: 28px; }
  section > h2 {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--muted); margin-bottom: 10px; font-weight: 600;
  }
  .hint { color: var(--muted); }
  .meta { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .state {
    border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px;
    font-size: 11px; color: var(--ink-2); white-space: nowrap;
  }
  .state-running { background: var(--debt-1); border-color: transparent; color: #fff; }
  .state-blocked { background: var(--ink); border-color: transparent; color: var(--page); }
  .branch, .when { color: var(--muted); font-size: 12px; }
  .rejects { color: var(--ink-2); font-size: 12px; }
  .goal-body { white-space: pre-wrap; max-width: 65ch; }
  .scope, .files { margin-top: 8px; display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
  .scope .k, .field .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  .scope code, .files code {
    background: var(--surface); border: 1px solid var(--grid); border-radius: 4px;
    padding: 0 5px; font-size: 11px; color: var(--ink-2);
  }
  ul.acceptance { margin: 8px 0 0 18px; max-width: 65ch; }
  ul.acceptance li { margin-top: 2px; white-space: pre-wrap; }
  .entry { border-top: 1px solid var(--grid); padding: 10px 0; }
  .entry .when { color: var(--muted); font-size: 11px; }
  .entry .title { margin-top: 2px; font-weight: 600; }
  .entry .body { margin-top: 2px; white-space: pre-wrap; max-width: 65ch; }
  .entry .field { margin-top: 2px; color: var(--ink-2); font-size: 12px; white-space: pre-wrap; max-width: 65ch; }
  ul.stages { margin: 4px 0 0 18px; }
  ul.stages li { color: var(--ink-2); font-size: 12px; max-width: 65ch; }
  .landed a { color: var(--debt-2); }
</style>
</head>
<body>
<header>
  <a class="back" href="report.html">← report</a>
  <h1 id="sid"></h1>
  <span class="state" id="state"></span>
  <span class="repo" id="repo"></span>
</header>
<main>
  <section>
    <h2>Session</h2>
    <div class="meta">
      <span class="branch" id="branch"></span>
      <span class="when" id="created"></span>
      <span class="rejects" id="rejects"></span>
    </div>
  </section>
  <section>
    <h2>What was asked</h2>
    <div id="intent"></div>
  </section>
  <section>
    <h2>Timeline</h2>
    <div id="timeline"></div>
  </section>
  <section class="landed">
    <h2>What landed</h2>
    <div id="landed"></div>
  </section>
  <section>
    <h2>Decision records</h2>
    <div id="decision-list"></div>
  </section>
</main>
<script id="pup-dossier-data" type="application/json">__PUP_DOSSIER_DATA__</script>
<script>
(() => {
  const data = JSON.parse(document.getElementById('pup-dossier-data').textContent);
  document.title = 'pup \\u00b7 ' + data.session.id;
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
  const codes = (parent, label, values) => {
    const row = el('div', 'files');
    const k = el('span', 'k');
    k.textContent = label;
    row.appendChild(k);
    for (const value of values) {
      const c = el('code');
      c.textContent = value;
      row.appendChild(c);
    }
    parent.appendChild(row);
  };

  document.getElementById('sid').textContent = data.session.id;
  const state = document.getElementById('state');
  state.textContent = data.session.state;
  // The column is unchecked TEXT: an unknown state keeps the neutral chip —
  // classList.add would throw on whitespace and blank the whole page.
  const KNOWN_STATES = ['queued', 'running', 'awaiting-review', 'merged', 'killed', 'rejected', 'blocked'];
  if (KNOWN_STATES.includes(data.session.state)) state.classList.add('state-' + data.session.state);
  document.getElementById('branch').textContent = data.session.branch;
  document.getElementById('created').textContent = when(data.session.createdAt);
  if (data.session.rejectCount > 0) {
    document.getElementById('rejects').textContent =
      data.session.rejectCount + (data.session.rejectCount === 1 ? ' rejection' : ' rejections');
  }

  // What was asked — the full spec with room to read; no disclosure here, the
  // whole page exists to give the intent its space.
  const intent = document.getElementById('intent');
  const goal = el('div', 'goal-body');
  goal.textContent = data.intent.goal || '(no goal recorded)';
  intent.appendChild(goal);
  if (data.intent.scopeIn.length)
    codes(intent, 'scope', data.intent.scopeIn);
  if (data.intent.scopeOut.length)
    codes(intent, 'not', data.intent.scopeOut);
  if (data.intent.acceptance.length) {
    const list = el('ul', 'acceptance');
    for (const criterion of data.intent.acceptance) {
      const li = el('li');
      li.textContent = criterion;
      list.appendChild(li);
    }
    intent.appendChild(list);
  }

  // Timeline — oldest first, every event, every gate run with its stages.
  const timeline = document.getElementById('timeline');
  if (!data.timeline.length) hint(timeline, 'No events recorded yet.');
  for (const t of data.timeline) {
    const entry = el('div', 'entry');
    const at = el('div', 'when');
    at.textContent = when(t.at);
    entry.appendChild(at);
    const title = el('div', 'title');
    title.textContent = t.title;
    entry.appendChild(title);
    if (t.body) {
      const body = el('div', 'body');
      body.textContent = t.body;
      entry.appendChild(body);
    }
    if (t.stages.length) {
      const list = el('ul', 'stages');
      for (const stage of t.stages) {
        const li = el('li');
        li.textContent =
          stage.stage + ' ' + stage.status.toUpperCase() + (stage.detail ? ' \\u2014 ' + stage.detail : '');
        list.appendChild(li);
      }
      entry.appendChild(list);
    }
    if (t.files.length) codes(entry, 'files', t.files);
    timeline.appendChild(entry);
  }

  // What landed — the merge that stands, with its PR when the gate opened one.
  const landed = document.getElementById('landed');
  if (!data.merge) {
    hint(landed, 'Nothing merged from this session.');
  } else {
    const line = el('div', 'body');
    line.textContent = data.merge.target ? 'merged into ' + data.merge.target : 'merged';
    landed.appendChild(line);
    if (data.merge.prUrl) {
      const a = el('a');
      // Scheme validated at render time (safeHttpUrl) — only http(s) reaches here.
      a.href = data.merge.prUrl;
      a.textContent = data.merge.prUrl;
      landed.appendChild(a);
    }
    if (data.merge.files.length) codes(landed, 'files', data.merge.files);
  }

  // Decision records — what this session settled, newest first.
  const decisions = document.getElementById('decision-list');
  if (!data.decisions.length) hint(decisions, 'No decision records from this session.');
  for (const record of data.decisions) {
    const div = el('div', 'entry');
    const at = el('div', 'when');
    at.textContent = '#' + record.id + ' \\u00b7 ' + when(record.createdAt);
    div.appendChild(at);
    const desc = el('div', 'body');
    desc.textContent = record.summary;
    div.appendChild(desc);
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
