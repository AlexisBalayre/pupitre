/**
 * What a window ran into that climbs its task one rung at the next relaunch or
 * respawn, or at the next CI fix round for `repeat-fix-round` (decision 92).
 */
export enum ClimbReason {
  GateRejection = 'gate-rejection',
  RepeatFixRound = 'repeat-fix-round',
  TurnDeath = 'turn-death',
  Stall = 'stall',
}
