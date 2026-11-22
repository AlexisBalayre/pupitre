import { globToRegExp } from './glob.utils.js';
import type { TicketType } from './types/profile.types.js';

/** A rule that forces a design on a ticket of any type (decision 176). */
type DesignTrigger = 'adr-area' | 'module-boundary' | 'dependency' | 'size';

/** What the intake check needs beyond the issue itself. */
export interface IntakeContext {
  /** Globs of the paths an ADR governs: a ticket touching one needs a design. */
  adrAreas: string[];
}

interface IntakeResult {
  /** Required headings absent from the body, by their heading text. */
  missing: string[];
  /** Required headings present but holding a placeholder, one word or an empty list item. */
  vague: string[];
  triggers: DesignTrigger[];
  /** A feature always; another type only when a trigger fires. */
  needsDesign: boolean;
}

/**
 * A required field: its heading in the issue form, and whether one word can
 * answer it, as a PR number, a time box, a path or a reviewer handle does.
 */
interface Field {
  heading: string;
  terse?: boolean;
  /** The field names where the work lands, so its paths feed the triggers. */
  area?: boolean;
}

const CHORE_FIELDS: Field[] = [
  { heading: 'Scope boundary', area: true },
  { heading: 'Proof that behavior is unchanged' },
  { heading: 'Files in scope', terse: true, area: true },
];

/** Docs and spike share one issue form; for docs, the form of the answer is the pages changed. */
const DOCS_SPIKE_FIELDS: Field[] = [
  { heading: 'What changes, or the question', area: true },
  { heading: 'Time box', terse: true },
  { heading: 'Form of the answer', terse: true, area: true },
];

/**
 * Each type's required fields (decision 176), headed by their issue form labels.
 * A type with no area field is read whole.
 */
const REQUIRED_FIELDS: Record<TicketType, Field[]> = {
  feature: [
    { heading: 'Goal' },
    { heading: 'Acceptance criteria' },
    { heading: 'Out of scope' },
    { heading: 'Affected area', terse: true, area: true },
  ],
  bug: [
    { heading: 'Reproduction' },
    { heading: 'Expected against actual' },
    { heading: 'Suspected area', terse: true, area: true },
  ],
  chore: CHORE_FIELDS,
  refactor: CHORE_FIELDS,
  docs: DOCS_SPIKE_FIELDS,
  spike: DOCS_SPIKE_FIELDS,
  'follow-up': [
    { heading: 'Source PR', terse: true },
    { heading: 'Findings' },
    { heading: 'Scenarios' },
    { heading: 'Original reviewers', terse: true },
  ],
};

/** The optional field whose line count is held against the cap. */
const ESTIMATE_HEADING = 'Estimate';

/** Decision 173's diff-size cap, in source lines per merge. */
const SIZE_CAP_LINES = 600;

/** A Markdown heading of any level, as GitHub issue forms render each field. */
const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;

/** A fenced code block's opening line; a backtick fence's info string holds no backtick. */
const FENCE_OPEN = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;

/** Text that holds a place without answering: what an issue form leaves unanswered too. */
const PLACEHOLDER =
  /^(?:_no response_|tbd|tbc|todo|n\/?a|none|null|nil|unknown|\?+|\.{2,}|…|-+|<[^>]*>|\[[^\]]*\])$/i;

/** A list item, checkbox or not, with nothing after its marker. */
const EMPTY_LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])(?:\s+\[[ xX]?\])?\s*$/m;

/** A path with at least one slash, or a file name with an extension. */
const PATH = /(?:[\w.-]+\/)+[\w.*-]+|\b[\w-]+\.(?:json|ts|js|md|ya?ml)\b/g;

/** A checked box that says the work adds a dependency. */
const DEPENDENCY_BOX = /^\s*[-*+]\s+\[[xX]\].*\bdependenc/im;

function normalize(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether a line closes the fence it opened: same character, at least as long, nothing after. */
function closesFence(line: string, fence: string): boolean {
  const marker = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)?.[1];
  return marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length;
}

/**
 * The body's sections, keyed by normalized heading; a repeated heading keeps its first.
 * As on GitHub, a heading inside a code fence is text, and an unclosed fence runs to the end.
 */
function sections(body: string): Map<string, string> {
  const found = new Map<string, string>();
  let current: string | undefined;
  let lines: string[] = [];
  let fence: string | undefined;
  const close = (): void => {
    if (current !== undefined && !found.has(current)) found.set(current, lines.join('\n').trim());
  };
  for (const line of body.split(/\r?\n/)) {
    const heading = fence === undefined ? HEADING.exec(line) : null;
    if (heading) {
      close();
      current = normalize(heading[1] ?? '');
      lines = [];
      continue;
    }
    lines.push(line);
    if (fence === undefined) fence = FENCE_OPEN.exec(line)?.[1];
    else if (closesFence(line, fence)) fence = undefined;
  }
  close();
  return found;
}

function isVague(value: string, terse: boolean): boolean {
  const text = value.trim();
  if (text === '' || PLACEHOLDER.test(text) || EMPTY_LIST_ITEM.test(text)) return true;
  return !terse && !/\s/.test(text);
}

/**
 * The module a path belongs to: its directory under `src/`, or under `test/<kind>/`
 * for a test, so a module's tests stay inside it. Undefined outside both. A path
 * whose last segment has no extension names a directory, as `src/cli/` does.
 */
function moduleOf(path: string): string | undefined {
  const parts = path.split('/');
  const directories = /\.\w+$/.test(parts.at(-1) ?? '') ? parts.length - 1 : parts.length;
  if (parts[0] === 'src' && directories > 1) return parts[1];
  if (parts[0] === 'test' && directories > 2) return parts[2];
  return undefined;
}

function triggersFor(
  body: string,
  areaText: string,
  sectionMap: Map<string, string>,
  context: IntakeContext,
): DesignTrigger[] {
  const paths = (areaText.match(PATH) ?? []).map((path) => path.replace(/^\.\//, ''));
  const adrAreas = context.adrAreas.map((glob) => globToRegExp(glob));
  const modules = new Set(paths.map(moduleOf).filter((name) => name !== undefined));
  const estimate = /\d[\d,]*/.exec(sectionMap.get(normalize(ESTIMATE_HEADING)) ?? '');
  // PATH drops a directory's trailing slash, so `src/cli/` must still match `src/cli/**`.
  const inAdrArea = (path: string): boolean =>
    adrAreas.some((area) => area.test(path) || area.test(`${path}/`));
  const fired: [DesignTrigger, boolean][] = [
    ['adr-area', paths.some(inAdrArea)],
    ['module-boundary', modules.size > 1],
    [
      'dependency',
      DEPENDENCY_BOX.test(body) || paths.some((path) => /(?:^|\/)package\.json$/.test(path)),
    ],
    ['size', estimate !== null && Number(estimate[0].replace(/,/g, '')) > SIZE_CAP_LINES],
  ];
  return fired.filter(([, on]) => on).map(([trigger]) => trigger);
}

/**
 * Check a tracker issue's body against its type's required fields and name the
 * design triggers it fires (decision 176). Pure: the ADR areas come in through
 * the context, and the body is treated as data, never followed.
 */
export function checkTicketIntake(
  body: string,
  type: TicketType,
  context: IntakeContext,
): IntakeResult {
  const sectionMap = sections(body);
  const fields = REQUIRED_FIELDS[type];
  const missing: string[] = [];
  const vague: string[] = [];
  for (const field of fields) {
    const value = sectionMap.get(normalize(field.heading));
    if (value === undefined) missing.push(field.heading);
    else if (isVague(value, field.terse === true)) vague.push(field.heading);
  }
  const areaFields = fields.filter((field) => field.area === true);
  const areaText =
    areaFields.length === 0
      ? body
      : areaFields.map((field) => sectionMap.get(normalize(field.heading)) ?? '').join('\n');
  const triggers = triggersFor(body, areaText, sectionMap, context);
  return { missing, vague, triggers, needsDesign: type === 'feature' || triggers.length > 0 };
}
