import { parse } from 'yaml';
import { CI_REVIEW_SKILL } from './constants/merge-gate.constants.js';

/** A skill's manifest under the skills exception, in any case; group 1 is its directory. */
const SKILL_MANIFEST = /^\.claude\/skills\/(?:[^/]+\/)*([^/]+)\/skill\.md$/i;

/**
 * A frontmatter block, read wider than Claude Code may (a BOM or blank lines
 * before it) so the check reads at least what it reads; group 1 is the YAML,
 * undefined when the block is empty.
 */
const FRONTMATTER = /^﻿?\s*---[ \t]*\r?\n((?:[\s\S]*?\r?\n)?)---[ \t]*(?:\r?\n|$)/;
const FRONTMATTER_OPENING = /^﻿?\s*---[ \t]*\r?\n/;

/** Whether `path` is a skill's `SKILL.md` under `.claude/skills/`, in any case (decision 208). */
export function isSkillManifest(path: string): boolean {
  return SKILL_MANIFEST.test(path);
}

/**
 * Whether a skill's `SKILL.md` declares a frontmatter `name:` other than its
 * directory's, or the CI review's (decision 208). Claude Code takes a skill's
 * name, and so its slash command, from `name:`, so a skill named other than
 * its directory could answer `/pr-ci-review` from outside the directory the
 * gate keeps. Read fail-closed: a frontmatter left open, one that is not a
 * single YAML document, or a `name:` that is not exactly the directory's
 * string is refused. A skill with no `name:` takes its directory's. Merge keys
 * are applied, as a YAML 1.1 reader applies them. Any other path is not a
 * skill's manifest and passes.
 */
export function isMisnamedSkill(path: string, content: string): boolean {
  const directory = SKILL_MANIFEST.exec(path)?.[1];
  if (directory === undefined) return false;
  const block = FRONTMATTER.exec(content);
  if (block === null) return FRONTMATTER_OPENING.test(content);
  let front: unknown;
  try {
    front = parse(block[1] ?? '', { merge: true });
  } catch {
    return true;
  }
  if (front === null || typeof front !== 'object' || !('name' in front)) return false;
  const { name } = front;
  return typeof name !== 'string' || name.toLowerCase() === CI_REVIEW_SKILL || name !== directory;
}
