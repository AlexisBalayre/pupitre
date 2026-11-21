/**
 * Every type the store holds, including `landed`, which `pup land` writes
 * (decision 84), `fix_round`, which `pup fix` writes (decision 90), `rescope`,
 * which `pup plan edit --rescope` writes (decision 115), `retired`, which `pup
 * retire` writes (decision 141), `pr_closed`, which `pup land --abandon-closed`
 * writes (decision 146), and `conductor_start`. The `events.type` column takes
 * any text: no CHECK constraint names the types.
 */
export enum EventType {
  ToolCall = 'tool_call',
  ScopeViolation = 'scope_violation',
  GateResult = 'gate_result',
  Merge = 'merge',
  Steer = 'steer',
  Interrupt = 'interrupt',
  ConfigDrift = 'config_drift',
  SessionDone = 'session_done',
  Question = 'question',
  Answer = 'answer',
  HandoffReady = 'handoff_ready',
  Respawn = 'respawn',
  ScopeOverlap = 'scope_overlap',
  UtilityCall = 'utility_call',
  TurnDied = 'turn_died',
  CacheHold = 'cache_hold',
  Landed = 'landed',
  FixRound = 'fix_round',
  Rescope = 'rescope',
  Retired = 'retired',
  PrClosed = 'pr_closed',
  ConductorStart = 'conductor_start',
}
