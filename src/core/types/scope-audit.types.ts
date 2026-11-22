export interface ScopeViolation {
  path: string;
  reason:
    | 'protected path'
    | 'matches scope-out'
    | 'outside scope-in'
    | 'misnamed skill'
    | 'not a plain file';
}
