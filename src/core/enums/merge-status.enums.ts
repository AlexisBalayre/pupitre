/**
 * `merged` landed on the target branch — or, with `openPr`, passed the gate and
 * left pupitre's custody as a pull request; `refused` means the soft diff-size
 * flag blocked the merge but the session stays in awaiting-review (a human
 * decides); `rejected` re-steered the session with the report; `blocked` parked
 * it (reject cap reached or the session was unreachable).
 */
export enum MergeStatus {
  Merged = 'merged',
  Refused = 'refused',
  Rejected = 'rejected',
  Blocked = 'blocked',
}
