import { globToRegExp, globToRegExpSource } from './glob.utils.js';
import { PROTECTED_PATH_GLOBS } from './merge-gate.constants.js';

export interface ScopeViolation {
  path: string;
  reason: 'protected path' | 'matches scope-out' | 'outside scope-in';
}

/**
 * Check repo-relative diff paths against a task's scope. Precedence: protected
 * paths always violate, scope-out wins over scope-in, and anything not matched
 * by a scope-in glob is a violation (the gate is a hard backstop, decision 6).
 */
export function auditScope(
  paths: string[],
  scopeIn: string[],
  scopeOut: string[] = [],
): ScopeViolation[] {
  // Case-insensitive so `.CLAUDE/…` can't dodge the backstop on a
  // case-insensitive filesystem (macOS default).
  const protectedRes = PROTECTED_PATH_GLOBS.map((g) => new RegExp(globToRegExpSource(g), 'i'));
  const inRes = scopeIn.map(globToRegExp);
  const outRes = scopeOut.map(globToRegExp);

  const violations: ScopeViolation[] = [];
  for (const path of paths) {
    if (protectedRes.some((re) => re.test(path))) {
      violations.push({ path, reason: 'protected path' });
    } else if (outRes.some((re) => re.test(path))) {
      violations.push({ path, reason: 'matches scope-out' });
    } else if (!inRes.some((re) => re.test(path))) {
      violations.push({ path, reason: 'outside scope-in' });
    }
  }
  return violations;
}
