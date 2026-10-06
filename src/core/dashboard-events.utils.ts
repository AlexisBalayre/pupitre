import { sanitizeReason } from '../adapters/capability.utils.js';
import type { DashboardGate } from './types/dashboard.types.js';
import type { SessionEvent } from './types/session-event.types.js';

/**
 * What an event's payload says, in the words a person reads it in: the
 * transition and the verdict on a gate result, the kind and sender of a steer,
 * the summary a session finished with, the question it asked. Ids, hashes and
 * file lists stay in the store — `pup report` is where they are read — and a
 * payload with nothing to say leaves the line as its type and its time.
 *
 * `gate` is the run a `gate_result` event reports, as the snapshot service
 * read it: the verdict here and the stage list on the row come from one
 * reading of the report, and a util does not reach into a service for it.
 */
export function eventDetail(
  event: SessionEvent,
  gate: DashboardGate | undefined,
): string | undefined {
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' ? sanitizeReason(value) : undefined;
  const line = (...parts: (string | undefined)[]): string | undefined =>
    parts.filter(Boolean).join(' · ') || undefined;
  switch (event.type) {
    case 'gate_result': {
      const [from, to] = [text(event.from), text(event.to)];
      const verdict = gate?.passed
        ? 'gate passed'
        : gate && `gate failed${gate.failedStage ? ` at ${gate.failedStage}` : ''}`;
      return line(
        from && to ? `${from} → ${to}` : undefined,
        verdict,
        text(event.outcome),
        text(event.reason),
      );
    }
    case 'steer': {
      const by = text(event.by);
      return line(text(event.kind), by && `by ${by}`);
    }
    case 'turn_died':
      return line(text(event.reason), text(event.refusal));
    case 'session_done':
      return text(event.summary);
    case 'question':
      return text(event.text);
    case 'merge': {
      const target = text(event.target);
      return text(event.prUrl) ?? (target && `into ${target}`);
    }
    case 'handoff_ready':
      return undefined;
    default:
      return text(event.fields.kind);
  }
}
