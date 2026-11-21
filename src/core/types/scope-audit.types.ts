export interface ScopeViolation {
  path: string;
  reason: 'protected path' | 'matches scope-out' | 'outside scope-in';
}
