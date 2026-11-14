import type { Database } from 'better-sqlite3';

import { capturePane, SessionPaneMissingError } from '../claude/session-runtime.service.js';
import { buildDashboardSnapshot, routeLabel } from './dashboard.service.js';
import { displayText } from './report-data.utils.js';
import { getSession } from './session.repository.js';
import { sessionPane } from './session-lifecycle.service.js';
import type { DashboardSession } from './types/dashboard.types.js';
import {
  actionButton,
  actionForm,
  answerForms,
  textAction,
} from './web-dashboard-actions.service.js';
import { escapeHtml, hint, section, textOrPrLink } from './web-dashboard-sheet.utils.js';

/** What one render of a session's view reads: its snapshot row and what its window shows. */
interface SessionView {
  session: DashboardSession;
  pane: { text: string } | { hint: string };
}

/**
 * A session's view (decision 91), or undefined for an id the store does not
 * hold in the minted shape: nothing is built around another one, as no
 * command is. The pane is read through the runtime, the one place tmux is
 * spoken to, at the pane pinned at launch.
 */
export function readSessionView(
  db: Database,
  repoPath: string,
  sessionId: string,
  now: number,
): SessionView | undefined {
  const session = buildDashboardSnapshot(db, repoPath, now).sessions.find(
    (s) => s.isMintedId && s.id === sessionId,
  );
  return session && { session, pane: readPane(db, sessionId) };
}

/** What the worker's window shows, or why there is nothing to show. */
function readPane(db: Database, sessionId: string): SessionView['pane'] {
  const row = getSession(db, sessionId);
  if (!row || row.state === 'killed') return { hint: 'No window: the session was killed.' };
  // Its window closed at the merge, and the pane id it kept can name another
  // window once tmux restarts (a fix round runs as `running`, with its own pane).
  if (row.state === 'merged')
    return { hint: 'No window: the session merged and its window closed.' };
  try {
    return { text: capturePane(sessionPane(row)) };
  } catch (error) {
    if (error instanceof SessionPaneMissingError) {
      return { hint: 'No live window: its pane is gone or was never recorded.' };
    }
    return { hint: 'The pane could not be read right now.' };
  }
}

/**
 * The part of the view the stream refreshes: where the session stands, its
 * open question with the answers, and the pane. The pane is the window's
 * text, which the worker wrote: control characters and direction marks are
 * replaced and markup escaped, line breaks kept.
 */
export function renderSessionBoard({ session, pane }: SessionView): string {
  const facts = [
    `state: ${session.state}`,
    routeLabel(session),
    session.rejectCount > 0 ? `${session.rejectCount} rejections` : '',
    session.lastGate
      ? `last gate: ${session.lastGate.passed ? 'passed' : `failed${session.lastGate.failedStage ? ` at ${session.lastGate.failedStage}` : ''}`} at ${session.lastGate.at}`
      : '',
  ].filter(Boolean);
  const question = session.question
    ? `<div class="need need-question"><span class="reason">${escapeHtml(session.question.text)}</span>` +
      answerForms(session.id, session.question) +
      '</div>'
    : '';
  const shown =
    'text' in pane
      ? `<pre class="pane">${escapeHtml(displayText(pane.text))}</pre>`
      : hint(pane.hint);
  return (
    section(
      'Session',
      `<div class="goal">${escapeHtml(session.goal || '(no goal recorded)')}</div>` +
        facts.map((fact) => `<div class="fact">${escapeHtml(fact)}</div>`).join('') +
        question,
    ) + section('Window', shown)
  );
}

/**
 * The head of the view, streamed with its board since the page holds nothing
 * from the store: the attach line to copy, the pull request as a link, and
 * the actions the session's state admits. A merge here
 * is always `--pr`, and the PR is merged on GitHub, which the page only links
 * to: no button merges there (decision 91).
 */
export function renderSessionHead({ session }: SessionView): string {
  const id = session.id;
  const attach = `pup attach ${id}`;
  const pr = session.openPr?.url;
  const fields = { session: id };
  const merge = actionForm(
    'merge',
    fields,
    '<input type="text" name="reason" placeholder="accept flags as debt: reason">' +
      '<input type="text" name="reviewBy" placeholder="review by">' +
      '<input type="text" name="approver" value="human" placeholder="approver">' +
      `<button type="submit">${escapeHtml(session.state === 'merged' ? 'Re-gate the PR' : 'Gate and open a PR')}</button>`,
    'act wide',
  );
  const actions =
    session.state === 'killed'
      ? []
      : session.state === 'merged'
        ? [
            actionButton('fix', fields, 'Start a fix round'),
            merge,
            actionButton('land', fields, 'Land'),
          ]
        : [
            textAction('steer', fields, 'message', 'a correction for the worker', 'Steer'),
            merge,
            actionButton('kill', fields, 'Kill'),
          ];
  return section(
    `Session ${id}`,
    `<p class="attach"><code id="attach">${escapeHtml(attach)}</code> ` +
      '<button type="button" data-copy="attach">Copy</button></p>' +
      (pr === undefined
        ? ''
        : `<p class="fact">Pull request, merged on GitHub: ${textOrPrLink(pr)}</p>`) +
      (actions.length === 0 ? hint('Killed: nothing left to act on.') : actions.join('')),
  );
}
