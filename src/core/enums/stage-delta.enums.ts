/** 'changed' covers fail<->skipped moves: neither passes, so neither word fits. */
export enum StageDelta {
  Regressed = 'regressed',
  Improved = 'improved',
  Changed = 'changed',
  Unchanged = 'unchanged',
}
