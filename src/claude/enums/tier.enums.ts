/**
 * A task's risk class, derived from its scope-in by `tierForScope` unless the
 * operator set one with `pup plan add|edit --tier`.
 */
export enum Tier {
  Standard = 'standard',
  Critical = 'critical',
}
