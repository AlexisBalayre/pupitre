import type { Database } from 'better-sqlite3';

import { listDecisionRecords } from './decision-record.repository.js';
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
import { type EventRow, listEvents, listTasks, type SessionRow } from './session.repository.js';
import { SESSION_ID_PATTERN } from './session-activity.constants.js';
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
      .map(decisionRecordDatum),
  };
  // `<` escaped so agent-written prose containing `</script>` cannot break out
  // of the data block; function replacer so $-patterns in that prose are not
  // expanded into template text (both per report.service).
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return HTML_TEMPLATE.replace('__PUP_DOSSIER_DATA__', () => json);
}

/**
 * Session ids are pup-generated, but the store is session-writable, so an id
 * is untrusted as a path fragment. Only ids from the shared allowlist get a
 * dossier file (and a link from the index); anything else — separators, dots,
 * a hostile `../` — stays unlinked instead of escaping the project dir. The
 * report renders a file name, so it degrades to no link; the store's own paths
 * throw on the same ids (decision 66).
 */
export function dossierFileName(sessionId: string): string | null {
  return SESSION_ID_PATTERN.test(sessionId) ? `session-${sessionId}.html` : null;
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
    case 'steer': {
      // A message steer names its sender; the timeline is where that is read.
      const by = typeof payload.by === 'string' ? `, by ${payload.by}` : '';
      datum.title =
        typeof payload.kind === 'string' ? displayText(`steer (${payload.kind}${by})`) : 'steer';
      break;
    }
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
${PAGE_SHELL_CSS}
  header a.back { color: var(--muted); text-decoration: none; }
  header a.back:hover { color: var(--ink-2); }
  .goal-body { white-space: pre-wrap; max-width: 65ch; }
  .scope, .files { margin-top: 8px; display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
  .scope code, .files code {
    background: var(--surface); border: 1px solid var(--grid); border-radius: 4px;
    padding: 0 5px; font-size: 11px; color: var(--ink-2);
  }
  ul.acceptance { margin: 8px 0 0 18px; max-width: 65ch; }
  ul.acceptance li { margin-top: 2px; white-space: pre-wrap; }
  .entry .title { margin-top: 2px; font-weight: 600; }
  .entry .body { margin-top: 2px; white-space: pre-wrap; max-width: 65ch; }
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
    <h2>What was learned</h2>
    <div id="decision-list"></div>
  </section>
</main>
<script id="pup-dossier-data" type="application/json">__PUP_DOSSIER_DATA__</script>
<script>
(() => {
  const data = JSON.parse(document.getElementById('pup-dossier-data').textContent);
  document.title = 'pup \\u00b7 ' + data.session.id;
  document.getElementById('repo').textContent = data.repoPath;

${PAGE_SHELL_JS}
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
  stateChip(document.getElementById('state'), data.session.state);
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
        li.textContent = stageText(stage);
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
    decisionFields(div, record);
    decisions.appendChild(div);
  }
})();
</script>
</body>
</html>
`;
