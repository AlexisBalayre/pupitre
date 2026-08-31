import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { openStore } from './db.client.js';
import { insertDecisionRecord } from './decision-record.repository.js';
import { projectId } from './paths.utils.js';
import {
  appendEvent,
  ensureProject,
  getSession,
  insertSession,
  insertTask,
  type SessionRow,
} from './session.repository.js';
import { dossierFileName, renderSessionDossierHtml } from './session-dossier.service.js';

const REPO = '/repo';
const PID = projectId(REPO);

function seedSession(db: Database, id: string, spec: Record<string, unknown>): SessionRow {
  insertTask(db, { id: `task-${id}`, projectId: PID, spec: JSON.stringify(spec) });
  insertSession(db, {
    id,
    taskId: `task-${id}`,
    worktreePath: `${REPO}/.worktrees/${id}`,
    branch: `pup/${id}`,
    profileHash: 'hash',
  });
  const session = getSession(db, id);
  if (!session) throw new Error(`seed failed for ${id}`);
  return session;
}

/** The JSON the page's script parses — the contract between service and client JS. */
function embeddedData(html: string) {
  return JSON.parse(/id="pup-dossier-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '');
}

describe('renderSessionDossierHtml', () => {
  let db: Database;
  beforeEach(() => {
    db = openStore(':memory:');
    ensureProject(db, PID, REPO);
  });

  it('produces a self-contained document (no external scripts, styles, or fetches)', () => {
    const session = seedSession(db, 's1', { goal: 'goal' });

    const html = renderSessionDossierHtml(db, REPO, session);

    expect(html).toContain('<!doctype html>');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toContain('https://');
  });

  it('embeds the full intent: goal, scope in and out, and acceptance criteria', () => {
    const session = seedSession(db, 's1', {
      goal: 'Ship the widget behind a flag',
      scopeIn: ['src/**'],
      scopeOut: ['docs/**'],
      acceptance: ['widget renders', 'flag defaults off'],
    });

    const data = embeddedData(renderSessionDossierHtml(db, REPO, session));

    expect(data.intent).toEqual({
      goal: 'Ship the widget behind a flag',
      scopeIn: ['src/**'],
      scopeOut: ['docs/**'],
      acceptance: ['widget renders', 'flag defaults off'],
    });
  });

  it('embeds the timeline oldest first with typed titles and gate stages', () => {
    const session = seedSession(db, 's1', { goal: 'goal' });
    appendEvent(db, 's1', 'steer', { kind: 'kickoff' });
    appendEvent(db, 's1', 'gate_result', {
      report: {
        sessionId: 's1',
        passed: false,
        sandbox: 'none',
        stages: [{ stage: 'test', status: 'fail', detail: '2 failing' }],
      },
    });
    appendEvent(db, 's1', 'gate_result', { from: 'running', to: 'awaiting-review' });
    appendEvent(db, 's1', 'session_done', { summary: 'widget shipped' });

    const data = embeddedData(renderSessionDossierHtml(db, REPO, session));

    expect(data.timeline.map((t: { title: string }) => t.title)).toEqual([
      'steer (kickoff)',
      'gate failed',
      'running → awaiting-review',
      'done',
    ]);
    expect(data.timeline[1].stages).toEqual([
      { stage: 'test', status: 'fail', detail: '2 failing' },
    ]);
    expect(data.timeline[3].body).toBe('widget shipped');
  });

  it('drops poisoned gate-stage members instead of dying server- or client-side', () => {
    const session = seedSession(db, 's1', { goal: 'goal' });
    appendEvent(db, 's1', 'gate_result', {
      report: {
        sessionId: 's1',
        passed: false,
        sandbox: 'none',
        stages: [null, { stage: 'test' }, { stage: 'lint', status: 'pass' }],
      },
    });

    const data = embeddedData(renderSessionDossierHtml(db, REPO, session));

    expect(data.timeline[0].stages).toEqual([{ stage: 'lint', status: 'pass', detail: null }]);
  });

  it('replaces bidi overrides in prose but keeps the newlines pre-wrap renders', () => {
    const session = seedSession(db, 's1', {
      goal: 'line one\nrenamed src/\u202est.esac_tset.ts',
    });

    const data = embeddedData(renderSessionDossierHtml(db, REPO, session));

    expect(data.intent.goal).toBe('line one\nrenamed src/\uFFFDst.esac_tset.ts');
  });

  it('titles a refused gate run as refused even when a report rides along', () => {
    const session = seedSession(db, 's1', { goal: 'goal' });
    appendEvent(db, 's1', 'gate_result', {
      outcome: 'refused',
      report: { sessionId: 's1', passed: false, sandbox: 'none', stages: [] },
    });

    const data = embeddedData(renderSessionDossierHtml(db, REPO, session));

    expect(data.timeline[0].title).toBe('gate refused');
  });

  it('embeds what landed from the merge event: target, files, PR URL', () => {
    const session = seedSession(db, 's1', { goal: 'goal' });
    appendEvent(db, 's1', 'merge', {
      branch: 'pup/s1',
      target: 'main',
      files: ['src/a.ts', 'src/b.ts'],
      prUrl: 'https://github.com/o/r/pull/1',
    });

    const data = embeddedData(renderSessionDossierHtml(db, REPO, session));

    expect(data.merge).toEqual({
      target: 'main',
      files: ['src/a.ts', 'src/b.ts'],
      prUrl: 'https://github.com/o/r/pull/1',
    });
  });

  it('drops a PR URL whose scheme is not http(s) before it can reach an anchor', () => {
    const session = seedSession(db, 's1', { goal: 'goal' });
    appendEvent(db, 's1', 'merge', {
      branch: 'pup/s1',
      target: 'main',
      files: [],
      prUrl: 'javascript:alert(1)',
    });

    const data = embeddedData(renderSessionDossierHtml(db, REPO, session));

    expect(data.merge.prUrl).toBeNull();
  });

  it("embeds only this session's decision records", () => {
    const session = seedSession(db, 's1', { goal: 'goal' });
    seedSession(db, 's2', { goal: 'other goal' });
    insertDecisionRecord(db, {
      sessionId: 's1',
      summary: 'Adopted the gate lock',
      files: ['src/core/a.ts'],
    });
    insertDecisionRecord(db, {
      sessionId: 's2',
      summary: 'A decision from elsewhere',
      files: [],
    });

    const data = embeddedData(renderSessionDossierHtml(db, REPO, session));

    expect(data.decisions).toEqual([
      expect.objectContaining({ summary: 'Adopted the gate lock', files: ['src/core/a.ts'] }),
    ]);
  });

  it('renders an event type nothing special-cases as its type plus raw payload', () => {
    const session = seedSession(db, 's1', { goal: 'goal' });
    appendEvent(db, 's1', 'scope_violation', { path: 'docs/00.md' });

    const data = embeddedData(renderSessionDossierHtml(db, REPO, session));

    expect(data.timeline[0]).toMatchObject({
      title: 'scope_violation',
      body: '{"path":"docs/00.md"}',
    });
  });

  it('normalises event and session timestamps to ISO UTC', () => {
    const session = seedSession(db, 's1', { goal: 'goal' });
    appendEvent(db, 's1', 'session_done', { summary: 'done' });
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run('2026-08-03 12:36:05', 's1');
    db.prepare('UPDATE events SET created_at = ?').run('2026-08-04 09:00:00');

    const data = embeddedData(
      renderSessionDossierHtml(db, REPO, { ...session, created_at: '2026-08-03 12:36:05' }),
    );

    expect(data.session.createdAt).toBe('2026-08-03T12:36:05Z');
    expect(data.timeline[0].at).toBe('2026-08-04T09:00:00Z');
  });

  it('keeps hostile prose inside the data block', () => {
    const session = seedSession(db, 's-evil', {
      goal: 'Fix </script><script>alert(1)</script> and <img onerror=alert(2) src=x>',
    });
    appendEvent(db, 's-evil', 'session_done', { summary: '</script> in a summary' });

    const html = renderSessionDossierHtml(db, REPO, session);

    expect(html).not.toContain('</script><script>');
    expect(html).not.toContain('<img');
    // Only the template's own two closers exist — the payload added none.
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(embeddedData(html).intent.goal).toContain('<img onerror=alert(2) src=x>');
  });

  it('keeps $-patterns in prose from splicing template text into the data block', () => {
    const goal = "use $' for a newline in bash, $& in sed, and $` for the prefix";
    const session = seedSession(db, 's-dollar', { goal });

    const html = renderSessionDossierHtml(db, REPO, session);

    expect(embeddedData(html).intent.goal).toBe(goal);
    expect(html.match(/<\/script>/g)).toHaveLength(2);
  });

  it('renders a session whose task row is missing with empty intent instead of throwing', () => {
    const session = seedSession(db, 's1', { goal: 'goal' });
    db.pragma('foreign_keys = OFF');
    db.prepare("UPDATE sessions SET task_id = 'task-ghost' WHERE id = 's1'").run();

    const data = embeddedData(
      renderSessionDossierHtml(db, REPO, { ...session, task_id: 'task-ghost' }),
    );

    expect(data.intent).toEqual({ goal: '', scopeIn: [], scopeOut: [], acceptance: [] });
  });
});

describe('dossierFileName', () => {
  it('names a file for an id from the closed charset', () => {
    expect(dossierFileName('t-msdc5rls')).toBe('session-t-msdc5rls.html');
  });

  it('refuses ids that could escape the project dir or break the link', () => {
    expect(dossierFileName('../evil')).toBeNull();
    expect(dossierFileName('a/b')).toBeNull();
    expect(dossierFileName('a.b')).toBeNull();
    expect(dossierFileName('')).toBeNull();
    expect(dossierFileName('a'.repeat(65))).toBeNull();
  });
});
