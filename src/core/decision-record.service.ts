import type { Database } from 'better-sqlite3';
import { runUtility } from '../claude/utility.service.js';
import { insertDecisionRecord } from './decision-record.repository.js';
import { appendEvent } from './session.repository.js';
import type { TaskSpec } from './types/profile.types.js';

export interface DraftDecisionRecordInput {
  sessionId: string;
  spec: TaskSpec;
  files: string[];
  /** Commit subjects on the merged branch, oldest first. */
  commitSubjects: string[];
}

interface DraftedRecord {
  summary: string;
  alternatives?: string;
  conventions?: string;
}

function draftPrompt(input: DraftDecisionRecordInput): string {
  return [
    'You are drafting a decision record for a merge log. From the task and diff below, answer',
    '"why is it done this way" for a future reader. Respond with ONLY a JSON object, no fences:',
    '{"summary": "<=2 sentences: what was decided and why", "alternatives": "<=1 sentence: plausible approaches not taken, or null", "conventions": "<=1 sentence: conventions this merge applied or established, or null"}',
    '',
    `Task goal: ${input.spec.goal}`,
    `Acceptance criteria: ${input.spec.acceptance.join('; ')}`,
    `Files changed: ${input.files.join(', ')}`,
    `Commits: ${input.commitSubjects.join(' | ')}`,
  ].join('\n');
}

function parseDraft(output: string): DraftedRecord | undefined {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof parsed.summary !== 'string' || parsed.summary.length === 0) return undefined;
    return {
      summary: parsed.summary,
      alternatives: typeof parsed.alternatives === 'string' ? parsed.alternatives : undefined,
      conventions: typeof parsed.conventions === 'string' ? parsed.conventions : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Draft one record per merge (docs/05) via a `claude -p` utility (decision 11).
 * Never blocks a landed merge: on utility failure or unparseable output it
 * falls back to a mechanical record from the task spec and commit subjects,
 * and the utility_call event records which path was taken.
 */
export function draftDecisionRecord(db: Database, input: DraftDecisionRecordInput): number {
  const utility = runUtility(draftPrompt(input));
  const drafted = utility.ok ? parseDraft(utility.output) : undefined;
  appendEvent(db, input.sessionId, 'utility_call', {
    kind: 'decision-record-draft',
    ok: Boolean(drafted),
    detail: drafted ? undefined : utility.output.slice(-500),
  });
  const record = drafted ?? {
    summary: `${input.spec.goal} (mechanical record: ${input.commitSubjects.join(' | ') || 'no commits listed'})`,
  };
  return insertDecisionRecord(db, {
    sessionId: input.sessionId,
    summary: record.summary,
    alternatives: record.alternatives,
    conventions: record.conventions,
    files: input.files,
  });
}
