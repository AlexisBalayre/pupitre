import {
  PROTECTED_PATH_EXCEPTIONS,
  PROTECTED_PATH_GLOBS,
  PROTECTED_WITHIN_EXCEPTIONS,
} from './constants/merge-gate.constants.js';
import { globToRegExp, globToRegExpSource } from './glob.utils.js';
import { isMisnamedSkill, isSkillManifest } from './skill-name.utils.js';
import type { ScopeViolation } from './types/scope-audit.types.js';

/**
 * Case-insensitive so `.CLAUDE/…` can't dodge the backstop on a
 * case-insensitive filesystem (macOS default).
 */
function caseless(globs: readonly string[]): RegExp[] {
  return globs.map((g) => new RegExp(globToRegExpSource(g), 'i'));
}

/**
 * Check repo-relative diff paths against a task's scope. Precedence: protected
 * paths always violate, scope-out wins over scope-in, and anything not matched
 * by a scope-in glob is a violation (the gate is a hard backstop, decision 6).
 * A protected path is one under `PROTECTED_PATH_GLOBS` that no exception
 * lifts, or one under `PROTECTED_WITHIN_EXCEPTIONS` (decision 208). Given
 * `readFile`, which returns a path's content as the diff leaves it, undefined
 * for one the diff deletes, and null for one it cannot read as a plain file (a
 * symlink, whose target Claude Code would load), a skill's `SKILL.md` the
 * scope takes is refused as a misnamed skill when `isMisnamedSkill` says so or
 * its read is null. A reader that throws is not an answer, and its error
 * propagates.
 */
export function auditScope(
  paths: string[],
  scopeIn: string[],
  scopeOut: string[] = [],
  readFile?: (path: string) => string | null | undefined,
): ScopeViolation[] {
  const protectedRes = caseless(PROTECTED_PATH_GLOBS);
  const exceptionRes = caseless(PROTECTED_PATH_EXCEPTIONS);
  const unliftedRes = caseless(PROTECTED_WITHIN_EXCEPTIONS);
  const inRes = scopeIn.map(globToRegExp);
  const outRes = scopeOut.map(globToRegExp);
  const isProtected = (path: string): boolean =>
    (protectedRes.some((re) => re.test(path)) && !exceptionRes.some((re) => re.test(path))) ||
    unliftedRes.some((re) => re.test(path));
  const isMisnamed = (path: string): boolean => {
    if (readFile === undefined || !isSkillManifest(path)) return false;
    const content = readFile(path);
    return content === null || (content !== undefined && isMisnamedSkill(path, content));
  };

  const violations: ScopeViolation[] = [];
  for (const path of paths) {
    if (isProtected(path)) {
      violations.push({ path, reason: 'protected path' });
    } else if (outRes.some((re) => re.test(path))) {
      violations.push({ path, reason: 'matches scope-out' });
    } else if (!inRes.some((re) => re.test(path))) {
      violations.push({ path, reason: 'outside scope-in' });
    } else if (isMisnamed(path)) {
      violations.push({ path, reason: 'misnamed skill' });
    }
  }
  return violations;
}

/**
 * Which of `paths` a task with this scope is allowed to edit — the complement
 * of `auditScope`, so the same precedence decides both. Asking the gate's own
 * rule keeps the launch-time overlap check (decision 41) from drifting into a
 * second, laxer reading of a scope: a file a session could never commit is not
 * a file it can conflict over.
 */
export function scopedPaths(paths: string[], scopeIn: string[], scopeOut: string[] = []): string[] {
  const refused = new Set(auditScope(paths, scopeIn, scopeOut).map((violation) => violation.path));
  return paths.filter((path) => !refused.has(path));
}
