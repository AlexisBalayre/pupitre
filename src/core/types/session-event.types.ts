import type { SessionState } from '../db.client.js';
import type { GateReport } from './merge-gate.types.js';

/**
 * What a state transition adds to the `gate_result` it logs: the gate run that
 * caused it, why a session was parked, which hand moved it.
 */
export interface TransitionPayload {
  report?: GateReport;
  reason?: string;
  rejectCount?: number;
  summary?: string;
  profileHash?: string;
  kind?: string;
}

/**
 * The payload `appendEvent` writes for each event type. `tool_call`,
 * `scope_violation` and `config_drift` have no writer in pup: the session's
 * hooks append them to its events file, never to the store.
 */
export interface EventPayloads {
  gate_result:
    | ({ from: SessionState; to: SessionState } & TransitionPayload)
    | { outcome: 'refused'; report: GateReport };
  merge: { branch: string; target: string; files: string[]; prUrl?: string };
  steer: { kind: string; by?: string; delivered?: boolean };
  interrupt: { steered: boolean };
  session_done: { summary: string };
  question: { text: string };
  handoff_ready: { hash: string };
  respawn: { delivered: boolean; handoffBytes?: number; hard?: boolean };
  scope_overlap: { via: string; accepted: { session: string; files: string[] }[] };
  utility_call: { kind: string; ok: boolean; detail?: string };
  /** `stalledAt` for a session's dead turn, `target` for the conductor's (decision 47). */
  turn_died: { reason: string; refusal?: string } & ({ stalledAt: string } | { target: string });
  tool_call: Record<string, unknown>;
  scope_violation: { path: string; reason?: string; command?: string };
  config_drift: Record<string, unknown>;
}

/** A gate stage as the store holds it: shape-checked, its text not yet scrubbed for any sink. */
export interface StoredGateStage {
  stage: string;
  status: string;
  detail?: string;
}

export interface StoredGateReport {
  passed: boolean;
  stages: StoredGateStage[];
}

/**
 * One stored event, read back by `decodeEvent`. Every field is optional where
 * the store is: a payload is session-writable, so a field that is missing or
 * of the wrong type reads as absent. Nothing here is sanitized — each renderer
 * scrubs for its own sink (decision 68). A type nothing reads by field is
 * `other`, its payload kept as the object it parsed to.
 */
export type SessionEvent =
  | {
      type: 'gate_result';
      /** Absent on a bare transition, which says nothing about passing. */
      report?: StoredGateReport;
      from?: string;
      to?: string;
      outcome?: string;
      reason?: string;
    }
  | { type: 'merge'; target?: string; files: string[]; prUrl?: string }
  | { type: 'steer'; kind?: string; by?: string }
  | { type: 'session_done'; summary?: string }
  | { type: 'question'; text?: string }
  | { type: 'turn_died'; reason?: string; stalledAt?: string; refusal?: string }
  | { type: 'handoff_ready'; hash?: string }
  | { type: 'other'; eventType: string; fields: Record<string, unknown> };
