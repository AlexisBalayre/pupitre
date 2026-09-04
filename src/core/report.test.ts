import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { appendBaselineHistory } from './baseline-history.repository.js';
import { openStore } from './db.client.js';
import { insertDecisionRecord } from './decision-record.repository.js';
import { insertLedgerEntry } from './ledger.repository.js';
import { projectId } from './paths.utils.js';
import { renderReportHtml } from './report.service.js';
import { appendEvent, ensureProject, insertSession, insertTask } from './session.repository.js';

const REPO = '/repo';
const PID = projectId(REPO);

function seedSession(db: Database, id: string, goal: string): void {
  insertTask(db, {
    id: `task-${id}`,
    projectId: PID,
    spec: JSON.stringify({ id: `task-${id}`, goal, scopeIn: ['src/**'], acceptance: [] }),
  });
  insertSession(db, {
    id,
    taskId: `task-${id}`,
    worktreePath: `${REPO}/.worktrees/${id}`,
    branch: `pup/${id}`,
    profileHash: 'hash',
  });
}

/** The JSON the page's script parses — the contract between service and client JS. */
function embeddedData(html: string) {
  return JSON.parse(/id="pup-report-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '');
}

describe('renderReportHtml', () => {
  let db: Database;
  beforeEach(() => {
    db = openStore(':memory:');
    ensureProject(db, PID, REPO);
  });

  it('produces a self-contained document (no external scripts, styles, or fetches)', () => {
    const html = renderReportHtml(db, REPO);

    expect(html).toContain('<!doctype html>');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toContain('https://');
  });

  it('embeds a session with its goal, state, branch, scope and reject count', () => {
    seedSession(db, 's1', 'Improve the parser so nested templates survive');

    const html = renderReportHtml(db, REPO);

    expect(html).toContain('Improve the parser so nested templates survive');
    expect(embeddedData(html).sessions).toEqual([
      expect.objectContaining({
        id: 's1',
        state: 'queued',
        branch: 'pup/s1',
        goal: 'Improve the parser so nested templates survive',
        scopeIn: ['src/**'],
        rejectCount: 0,
        dossierFile: 'session-s1.html',
      }),
    ]);
  });

  // The section decision 40 left permanently blank: intent that has not run is
  // the report's answer to "what will be built" (decision 41).
  it('embeds a planned task with its goal and scope', () => {
    insertTask(db, {
      id: 't-plan',
      projectId: PID,
      spec: JSON.stringify({
        id: 't-plan',
        goal: 'extract the gh exec options',
        scopeIn: ['src/core/github.client.ts'],
        scopeOut: ['src/core/github.client.test.ts'],
      }),
    });

    expect(embeddedData(renderReportHtml(db, REPO)).backlog).toEqual([
      expect.objectContaining({
        id: 't-plan',
        goal: 'extract the gh exec options',
        scopeIn: ['src/core/github.client.ts'],
        scopeOut: ['src/core/github.client.test.ts'],
        origin: 'human',
      }),
    ]);
  });

  it('drops a task from the backlog once a session claims it', () => {
    seedSession(db, 's1', 'the claimed goal');

    expect(embeddedData(renderReportHtml(db, REPO)).backlog).toEqual([]);
  });

  it('links no dossier for a session id outside the filename allowlist', () => {
    seedSession(db, 's1', 'goal');
    db.prepare('UPDATE sessions SET id = ? WHERE id = ?').run('../evil', 's1');

    const [session] = embeddedData(renderReportHtml(db, REPO)).sessions;

    expect(session.dossierFile).toBeNull();
  });

  it('orders sessions newest first', () => {
    seedSession(db, 's-old', 'the earlier goal');
    seedSession(db, 's-new', 'the later goal');
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(
      '2026-07-01 10:00:00',
      's-old',
    );
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(
      '2026-08-01 10:00:00',
      's-new',
    );

    const data = embeddedData(renderReportHtml(db, REPO));

    expect(data.sessions.map((s: { id: string }) => s.id)).toEqual(['s-new', 's-old']);
  });

  it('renders the outcome: session_done summary and the last gate report with stages', () => {
    seedSession(db, 's1', 'ship the widget');
    appendEvent(db, 's1', 'gate_result', {
      report: {
        sessionId: 's1',
        passed: false,
        sandbox: 'none',
        stages: [{ stage: 'test', status: 'fail', detail: '2 failing' }],
      },
    });
    appendEvent(db, 's1', 'session_done', { summary: 'widget shipped behind a flag' });

    const [session] = embeddedData(renderReportHtml(db, REPO)).sessions;

    expect(session.doneSummary).toBe('widget shipped behind a flag');
    expect(session.gateStages).toEqual([{ stage: 'test', status: 'fail', detail: '2 failing' }]);
  });

  it('drops poisoned gate-stage members instead of killing the whole report', () => {
    seedSession(db, 's1', 'goal');
    appendEvent(db, 's1', 'gate_result', {
      report: { sessionId: 's1', passed: false, sandbox: 'none', stages: [null, { stage: 'x' }] },
    });

    const [session] = embeddedData(renderReportHtml(db, REPO)).sessions;

    expect(session.gateStages).toEqual([]);
  });

  it('normalises SQLite timestamps to ISO UTC and keeps capture timestamps as-is', () => {
    seedSession(db, 's1', 'goal');
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run('2026-08-03 12:36:05', 's1');
    appendBaselineHistory(db, {
      projectId: PID,
      capturedAt: '2026-08-03T10:00:00.000Z',
      stages: [],
    });

    const data = embeddedData(renderReportHtml(db, REPO));

    expect(data.sessions[0].createdAt).toBe('2026-08-03T12:36:05Z');
    expect(data.baselines[0].capturedAt).toBe('2026-08-03T10:00:00.000Z');
  });

  it('embeds drift points from baseline history oldest first, null where debt was unmeasured', () => {
    appendBaselineHistory(db, {
      projectId: PID,
      capturedAt: '2026-08-01T10:00:00.000Z',
      stages: [],
      debt: { duplicatedLines: 184, coverageRatio: 0.835 },
    });
    appendBaselineHistory(db, {
      projectId: PID,
      capturedAt: '2026-08-02T10:00:00.000Z',
      stages: [],
    });

    const data = embeddedData(renderReportHtml(db, REPO));

    expect(data.baselines).toEqual([
      {
        capturedAt: '2026-08-01T10:00:00.000Z',
        duplicatedLines: 184,
        coverageRatio: 0.835,
      },
      { capturedAt: '2026-08-02T10:00:00.000Z', duplicatedLines: null, coverageRatio: null },
    ]);
  });

  it('embeds open debt and decision records', () => {
    seedSession(db, 's1', 'goal');
    insertLedgerEntry(db, {
      projectId: PID,
      description: 'shortcut taken in the parser',
      files: ['src/parser.ts'],
      reason: 'ship the demo',
      acceptedBy: 'human',
      reviewBy: 'before v2',
    });
    insertDecisionRecord(db, {
      sessionId: 's1',
      summary: 'Adopted the gate lock',
      alternatives: 'a polling loop',
      conventions: 'locks live in the store',
      files: ['src/core/a.ts'],
    });

    const data = embeddedData(renderReportHtml(db, REPO));

    expect(data.debt).toEqual([
      expect.objectContaining({
        description: 'shortcut taken in the parser',
        reason: 'ship the demo',
        reviewBy: 'before v2',
      }),
    ]);
    expect(data.decisions).toEqual([
      expect.objectContaining({
        summary: 'Adopted the gate lock',
        alternatives: 'a polling loop',
        conventions: 'locks live in the store',
        files: ['src/core/a.ts'],
      }),
    ]);
  });

  it('strips bidi and control characters from decision-record prose', () => {
    // decisionRecordDatum is the ONE sanitization point for decision records on
    // both pages now — this pins its displayText pass where the duplicated
    // copies used to sit, so dropping it from a field cannot regress silently.
    seedSession(db, 's1', 'goal');
    insertDecisionRecord(db, {
      sessionId: 's1',
      summary: 'renamed the\u0007 helper',
      alternatives: 'keep the \u202eold name',
      files: ['src/\u202est.esac_tset.ts'],
    });

    const [decision] = embeddedData(renderReportHtml(db, REPO)).decisions;

    expect(decision.summary).toBe('renamed the\uFFFD helper');
    expect(decision.alternatives).toBe('keep the \uFFFDold name');
    expect(decision.files).toEqual(['src/\uFFFDst.esac_tset.ts']);
  });

  it('ships empty data with calm empty-state copy for a fresh store', () => {
    const html = renderReportHtml(db, REPO);

    const data = embeddedData(html);
    expect(data.sessions).toEqual([]);
    expect(data.baselines).toEqual([]);
    expect(data.debt).toEqual([]);
    expect(data.decisions).toEqual([]);
    // The client renders these plain statements when the arrays are empty.
    expect(html).toContain('No sessions recorded yet.');
    expect(html).toContain('No baseline captures yet.');
    expect(html).toContain('No open debt.');
    expect(html).toContain('No decision records yet.');
  });

  it('keeps a hostile goal inside the data block', () => {
    seedSession(
      db,
      's-evil',
      'Fix </script><script>alert(1)</script> and <img onerror=alert(2) src=x>',
    );

    const html = renderReportHtml(db, REPO);

    expect(html).not.toContain('</script><script>');
    expect(html).not.toContain('<img');
    // Only the template's own two closers exist — the payload added none.
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    // The goal still round-trips intact for the page to render via textContent.
    expect(embeddedData(html).sessions[0].goal).toContain('<img onerror=alert(2) src=x>');
  });

  it('keeps $-patterns in prose from splicing template text into the data block', () => {
    // String.replace expands $&/$'/$` in a string REPLACEMENT — $' would splice
    // the rest of the template (raw </script> included) into the data block.
    const goal = "use $' for a newline in bash, $& in sed, and $` for the prefix";
    seedSession(db, 's-dollar', goal);

    const html = renderReportHtml(db, REPO);

    expect(embeddedData(html).sessions[0].goal).toBe(goal);
    expect(html.match(/<\/script>/g)).toHaveLength(2);
  });

  it('renders a session whose task row is missing instead of dropping it', () => {
    seedSession(db, 's1', 'goal');
    db.pragma('foreign_keys = OFF');
    db.prepare("UPDATE sessions SET task_id = 'task-ghost' WHERE id = 's1'").run();

    const [session] = embeddedData(renderReportHtml(db, REPO)).sessions;

    expect(session).toMatchObject({ id: 's1', goal: '', scopeIn: [] });
  });

  it('degrades a malformed spec column to empty fields instead of throwing', () => {
    insertTask(db, { id: 'task-bad', projectId: PID, spec: 'not json {' });
    insertSession(db, {
      id: 's-bad',
      taskId: 'task-bad',
      worktreePath: `${REPO}/.worktrees/s-bad`,
      branch: 'pup/s-bad',
      profileHash: 'hash',
    });

    const [session] = embeddedData(renderReportHtml(db, REPO)).sessions;

    expect(session).toMatchObject({ id: 's-bad', goal: '', scopeIn: [], scopeOut: [] });
  });
});
