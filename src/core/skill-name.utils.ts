import { parse } from 'yaml';
import { CI_REVIEW_SKILL } from './constants/merge-gate.constants.js';

/** A skill's manifest under the skills exception, in any case; group 1 is its directory. */
const SKILL_MANIFEST = /^\.claude\/skills\/(?:[^/]+\/)*([^/]+)\/skill\.md$/i;

/**
 * The one frontmatter form the gate accepts: the file opens on a line of
 * exactly `---` ended by a bare LF, and the block closes on the first later
 * line of exactly `---`. Group 1 is the YAML between them, empty or ending in
 * a LF; a `---` anywhere in it is refused apart.
 */
const FRONTMATTER = /^---\n((?:[^\n]*\n)*?)---(?:\n|$)/;

/**
 * Whether a skill's `SKILL.md` is anything but a well-named skill in the one
 * form the gate accepts (decision 208). Claude Code takes a skill's name, and
 * so its slash command, from `name:`, so a skill named other than its
 * directory could answer `/pr-ci-review` from outside the directory the gate
 * keeps. Rather than guess how Claude Code reads frontmatter, the gate accepts
 * one strict form and refuses the rest: a manifest passes only if it matches
 * `FRONTMATTER`, holds no other `---` in its YAML, parses as one YAML document
 * (merge keys applied, as a YAML 1.1 reader applies them), and has no `name:`
 * or one exactly its directory's string that is not `pr-ci-review` in any
 * case. Any other path is not a skill's manifest and passes.
 */
export function isMisnamedSkill(path: string, content: string): boolean {
  const directory = SKILL_MANIFEST.exec(path)?.[1];
  if (directory === undefined) return false;
  const block = FRONTMATTER.exec(content);
  if (block === null) return true;
  const [, yaml = ''] = block;
  if (yaml.includes('---')) return true;
  let front: unknown;
  try {
    front = parse(yaml, { merge: true });
  } catch {
    return true;
  }
  if (front === null || typeof front !== 'object' || !('name' in front)) return false;
  const { name } = front;
  return typeof name !== 'string' || name.toLowerCase() === CI_REVIEW_SKILL || name !== directory;
}
