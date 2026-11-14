import { sanitizeReason } from '../adapters/capability.utils.js';
import { globToRegExp } from './glob.utils.js';
import { InvalidProfileError } from './profile.errors.js';
import { scopedPaths } from './scope-audit.utils.js';
import type { TaskSpec, TaskTicket } from './types/profile.types.js';

/** Control characters that must never reach a generated scope pattern file. */
const GLOB_UNSAFE = /[\r\n\0]/;

/**
 * The ticket types with no design by default (decision 176). Listed rather
 * than the one type that has one, so a type intake does not know yet needs
 * the label too.
 */
const UNDESIGNED_TICKET_TYPES: readonly string[] = [
  'bug',
  'chore',
  'refactor',
  'docs',
  'spike',
  'follow-up',
];

/** The label the operator adds once per ticket when they validate its design. */
const DESIGN_APPROVED_LABEL = 'design-approved';

/** A tracker reference, `#412`, `412` or `owner/repo#412`: nothing else reaches a heading. */
const TICKET_REF = /^(?:[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}#|#?)\d{1,10}$/;

/**
 * How much of a ticket a spec may hold (decision 187). Issue text is anyone's
 * who files one, and all of it is copied into every kickoff of its slices.
 */
const TICKET_TYPE_CHARS = 30;
const TICKET_DESIGN_CHARS = 8_000;
const TICKET_LIST_CAPS: [
  field: 'labels' | 'triggers' | 'criteria',
  count: number,
  chars: number,
][] = [
  ['labels', 30, 50],
  ['triggers', 10, 50],
  ['criteria', 20, 500],
];

/**
 * Refuse a ticket whose reference is not a tracker's, or that is over a cap
 * (decision 187). Refused rather than cut: a design or a criterion cut short
 * would tell the session less than the operator approved.
 */
function assertTicketBounds(ticket: TaskTicket): void {
  if (!TICKET_REF.test(ticket.ref)) {
    throw new InvalidProfileError(
      `Ticket reference "${sanitizeReason(ticket.ref)}" is not a tracker reference such as ` +
        '#412 or owner/repo#412.',
    );
  }
  const over: string[] = [];
  if (ticket.type.length > TICKET_TYPE_CHARS) {
    over.push(`its type is over ${TICKET_TYPE_CHARS} characters`);
  }
  if ((ticket.design ?? '').length > TICKET_DESIGN_CHARS) {
    over.push(`its design note is over ${TICKET_DESIGN_CHARS} characters`);
  }
  for (const [field, count, chars] of TICKET_LIST_CAPS) {
    if (ticket[field].length > count) over.push(`it has over ${count} ${field}`);
    if (ticket[field].some((item) => item.length > chars)) {
      over.push(`one of its ${field} is over ${chars} characters`);
    }
  }
  if (over.length > 0) {
    throw new InvalidProfileError(`Ticket ${ticket.ref} is over a cap: ${over.join('; ')}.`);
  }
}

/**
 * Refuse a task whose ticket needed a design the operator has not validated
 * (decision 187): a feature, or any type a design trigger fired on, without
 * the `design-approved` label. Each ticket string is scrubbed into the
 * message, which every caller prints.
 */
function assertDesignApproved(ticket: TaskTicket): void {
  if (ticket.labels.includes(DESIGN_APPROVED_LABEL)) return;
  const fired = ticket.triggers.length > 0;
  if (!fired && UNDESIGNED_TICKET_TYPES.includes(ticket.type)) return;
  const why = fired
    ? `design triggers fired on it (${ticket.triggers.map(sanitizeReason).join(', ')})`
    : `its type, ${sanitizeReason(ticket.type)}, has a design by default`;
  throw new InvalidProfileError(
    `Ticket ${sanitizeReason(ticket.ref)} has no ${DESIGN_APPROVED_LABEL} label, and ${why}: ` +
      'the operator validates its design before a slice of it starts.',
  );
}

/**
 * The subset of `compileProfile`'s validation a stored spec must satisfy to be
 * launchable at all. Compilation re-checks it; running it here moves the failure
 * to the command that caused it, which matters once a spec outlives the command
 * that wrote it (decision 40).
 *
 * The control-character rule is the load-bearing one: `scope-in.pat` is read by
 * `grep -qE -f`, where a blank line is a pattern matching every path, so one
 * newline inside a glob would turn the Edit/Write hook into allow-all.
 */
export function assertPlannableSpec(task: TaskSpec): void {
  // `?? []` because this now also runs over specs read back from the store,
  // where a row written before this validation existed can be missing `scopeIn`
  // entirely — the same refusal covers it, rather than a bare TypeError.
  if ((task.scopeIn ?? []).filter((glob) => glob.trim()).length === 0) {
    throw new InvalidProfileError(
      'Task scope-in is empty; a session with no scope can edit nothing.',
    );
  }
  for (const glob of [...task.scopeIn, ...(task.scopeOut ?? [])]) {
    if (GLOB_UNSAFE.test(glob)) {
      throw new InvalidProfileError(
        `Scope glob contains a control character: ${JSON.stringify(glob)}`,
      );
    }
  }
  if (task.ticket) {
    assertTicketBounds(task.ticket);
    assertDesignApproved(task.ticket);
  }
}

/** What a task's scope-in names among the tracked files, as its kickoff lists them. */
interface ScopeInFiles {
  /** Tracked files the task may edit, in `tracked`'s order. */
  files: string[];
  /** Scope-in globs that match no tracked path and name an editable one: files to create. */
  toCreate: string[];
}

/** Candidates `scopedPaths` takes per call, so the deadline is checked between calls. */
const SCOPE_BATCH = 1_000;

/**
 * The tracked files a task's scope-in matches, read with the gate's own
 * precedence (`scopedPaths`), so the kickoff never names a file the session
 * could not commit: a protected path or one scope-out takes back (decision 128).
 * A glob is to be created only when it matches no tracked path at all, before
 * that precedence, and its own text is not refused by it: a glob whose files
 * are all protected or under scope-out names nothing the session may add.
 * Undefined once `deadline` (a `Date.now()` instant) passes, checked between
 * paths: the listing is the repo's, which a session can plant to be huge.
 */
export function scopeInFiles(
  tracked: string[],
  task: Pick<TaskSpec, 'scopeIn' | 'scopeOut'>,
  deadline: number,
): ScopeInFiles | undefined {
  const scopeIn = task.scopeIn.filter((glob) => glob.trim());
  const inRes = scopeIn.map(globToRegExp);
  const matched = new Set<number>();
  const candidates: string[] = [];
  for (const path of tracked) {
    if (Date.now() > deadline) return undefined;
    const hits = inRes.flatMap((re, index) => (re.test(path) ? [index] : []));
    for (const index of hits) matched.add(index);
    if (hits.length > 0) candidates.push(path);
  }
  const files: string[] = [];
  for (let start = 0; start < candidates.length; start += SCOPE_BATCH) {
    if (Date.now() > deadline) return undefined;
    files.push(
      ...scopedPaths(candidates.slice(start, start + SCOPE_BATCH), scopeIn, task.scopeOut),
    );
  }
  // A glob's text, normalized as globToRegExp reads it, matches its own
  // pattern, so the gate's rule reads it as a path.
  const toCreate = scopeIn.filter(
    (glob, index) =>
      !matched.has(index) &&
      scopedPaths([glob.trim().replace(/^\.\//, '')], [glob], task.scopeOut).length > 0,
  );
  return { files, toCreate };
}
