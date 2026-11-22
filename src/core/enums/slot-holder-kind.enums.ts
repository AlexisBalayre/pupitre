/** Who takes a slot: the merge gate goes first, a worker's `pup session test` after it. */
export enum SlotHolderKind {
  Gate = 'gate',
  Worker = 'worker',
}
