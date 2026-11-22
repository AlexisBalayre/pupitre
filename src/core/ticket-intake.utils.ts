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
  { heading: 'Scope boundary' },
  { heading: 'Proof that behavior is unchanged' },
  { heading: 'Files in scope', terse: true, area: true },
];

/** Docs and spike share one issue form; for docs, the form of the answer is the pages changed. */
const DOCS_SPIKE_FIELDS: Field[] = [
  { heading: 'What changes, or the question', area: true },
  { heading: 'Time box', terse: true },
  { heading: 'Form of the answer', terse: true, area: true },
];

/** Each type's required fields (decision 176), headed by their issue form labels. */
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
    { heading: 'Findings', area: true },
    { heading: 'Scenarios' },
    { heading: 'Original reviewers', terse: true },
  ],
};

/** The optional field whose line count is held against the cap. */
const ESTIMATE_HEADING = 'Estimate';

/** Decision 173's diff-size cap, in source lines per merge. */
const SIZE_CAP_LINES = 600;

/**
 * A Markdown heading of any level, as GitHub issue forms render each field.
 * Trimming a closing `#` run here would backtrack on a long run of whitespace;
 * `normalize` drops that run with the other punctuation instead.
 */
const HEADING = /^#{1,6}\s+(\S.*)/;

/** A fenced code block's opening line; a backtick fence's info string holds no backtick. */
const FENCE_OPEN = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;

/**
 * Text that holds a place without answering: what an issue form leaves unanswered
 * too, alone or in Markdown emphasis or code, with one closing punctuation mark.
 */
const PLACEHOLDER =
  /^[*_`]*(?:_no response_|tbd|tbc|todo|n\/?a|none|null|nil|unknown|\?+|\.{2,}|…|-+|<[^>]*>|\[[^\]]*\])[*_`]*[.!:;]?$/i;

/**
 * One line holding a list item, checkbox or not, with nothing after its marker.
 * Tested line by line: across lines, `^\s*` backtracks on a run of blank lines.
 */
const EMPTY_LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])(?:\s+\[[ xX]?\])?\s*$/;

/**
 * A path with at least one slash, or a file name with an extension. A segment
 * after the first may hold a glob's wildcards; the first is a name or a bare
 * wildcard, so emphasis around a path is not read into it. A match starts only
 * where a run of path characters starts, which keeps the scan linear.
 */
const PATH =
  /(?<![\w.-])(?:\*{1,2}|[\w.-]+)\/(?:[\w.*-]+\/)*[\w.*-]+|(?<![\w-])[\w-]+\.(?:json|ts|js|md|ya?ml)\b/g;

/** A GitHub permalink's text before the repository path: host, owner, repo, view and ref. */
const PERMALINK = /^github\.com\/[\w.-]+\/[\w.-]+\/(?:blob|tree)\/[\w.-]+\//;

/** One line holding a checked box that says the work adds a dependency. */
const DEPENDENCY_BOX = /^\s*[-*+]\s+\[[xX]\].*\bdependenc/i;

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

/** A section's text, and its lines outside code fences, where a list item can be read. */
interface Section {
  text: string;
  prose: string[];
}

/**
 * The body's sections, keyed by normalized heading; a repeated heading keeps its first.
 * As on GitHub, a heading inside a code fence is text, and an unclosed fence runs to the end.
 */
function sections(body: string): Map<string, Section> {
  const found = new Map<string, Section>();
  let current: string | undefined;
  let lines: string[] = [];
  let prose: string[] = [];
  let fence: string | undefined;
  const close = (): void => {
    if (current !== undefined && !found.has(current)) {
      found.set(current, { text: lines.join('\n').trim(), prose });
    }
  };
  for (const line of body.split(/\r?\n/)) {
    const heading = fence === undefined ? HEADING.exec(line) : null;
    if (heading) {
      close();
      current = normalize(heading[1] ?? '');
      lines = [];
      prose = [];
      continue;
    }
    lines.push(line);
    if (fence !== undefined) {
      if (closesFence(line, fence)) fence = undefined;
      continue;
    }
    fence = FENCE_OPEN.exec(line)?.[1];
    if (fence === undefined) prose.push(line);
  }
  close();
  return found;
}

/** A `+` or `-` line of a fenced diff is not a list item, so only the prose is read for one. */
function isVague({ text, prose }: Section, terse: boolean): boolean {
  if (text === '' || PLACEHOLDER.test(text)) return true;
  if (prose.some((line) => EMPTY_LIST_ITEM.test(line))) return true;
  return !terse && !/\s/.test(text);
}

/**
 * The module a path belongs to: its directory under `src/`, or under `test/<kind>/`
 * for a test, so a module's tests stay inside it. Undefined outside both. A path
 * whose last segment has no extension and no wildcard names a directory, as
 * `src/cli/` does; `test/helpers/*` names files. A wildcard in the module's own
 * segment, or a `**` segment at or above it, as `src/**` has, reaches several
 * modules, and the module returned then holds a `*`.
 */
function moduleOf(path: string): string | undefined {
  const parts = path.split('/');
  const depth = parts[0] === 'src' ? 1 : parts[0] === 'test' ? 2 : 0;
  const globstar = parts.indexOf('**');
  if (globstar !== -1 && globstar <= depth) return '**';
  if (depth === 0) return undefined;
  const directories = /\.\w+$|\*/.test(parts.at(-1) ?? '') ? parts.length - 1 : parts.length;
  return directories > depth ? parts[depth] : undefined;
}

/** A glob's text before its first wildcard, which starts every path it matches. */
function literalPrefix(glob: string): string {
  return glob.split(/[*?]/, 1)[0] ?? '';
}

function triggersFor(
  body: string,
  areaText: string,
  sectionMap: Map<string, Section>,
  context: IntakeContext,
): DesignTrigger[] {
  // PATH keeps the period of a sentence that ends in a path; it is not part of the path.
  // The lookbehind starts the strip only at a run's first dot, which keeps it linear.
  // PATH starts a permalink's match at its host, so the strip leaves the repository path.
  const paths = (areaText.match(PATH) ?? []).map((path) =>
    path
      .replace(PERMALINK, '')
      .replace(/^\.\//, '')
      .replace(/(?<!\.)\.+$/, ''),
  );
  const adrAreas = context.adrAreas.map((glob) => ({
    pattern: globToRegExp(glob),
    prefix: literalPrefix(glob.trim().replace(/^\.\//, '')),
  }));
  const modules = [...new Set(paths.map(moduleOf).filter((name) => name !== undefined))];
  const estimate = /\d[\d,]*/.exec(sectionMap.get(normalize(ESTIMATE_HEADING))?.text ?? '');
  // PATH drops a directory's trailing slash, so `src/cli/` must still match `src/cli/**`,
  // and a literal path may name a directory holding an ADR area, as `src/claude` holds
  // `src/claude/hooks/**`: the area's literal prefix then starts with the path and a `/`.
  // A glob shares a path with an area only if one's literal prefix starts the other's:
  // that check may count a glob in an area it misses, never miss one it reaches.
  const inAdrArea = (path: string): boolean => {
    if (!path.includes('*')) {
      return adrAreas.some(
        ({ pattern, prefix }) =>
          pattern.test(path) || pattern.test(`${path}/`) || prefix.startsWith(`${path}/`),
      );
    }
    const prefix = literalPrefix(path);
    return adrAreas.some(
      (area) => area.prefix.startsWith(prefix) || prefix.startsWith(area.prefix),
    );
  };
  const fired: [DesignTrigger, boolean][] = [
    ['adr-area', paths.some(inAdrArea)],
    ['module-boundary', modules.length > 1 || modules.some((name) => name.includes('*'))],
    [
      'dependency',
      body.split(/\r?\n/).some((line) => DEPENDENCY_BOX.test(line)) ||
        paths.some((path) => /(?:^|\/)package\.json$/.test(path)),
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
  const areaText = fields
    .filter((field) => field.area === true)
    .map((field) => sectionMap.get(normalize(field.heading))?.text ?? '')
    .join('\n');
  const triggers = triggersFor(body, areaText, sectionMap, context);
  return { missing, vague, triggers, needsDesign: type === 'feature' || triggers.length > 0 };
}
