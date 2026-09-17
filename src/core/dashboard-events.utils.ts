import { sanitizeReason } from '../adapters/capability.utils.js';
import { parseJsonOr } from './report-data.utils.js';
import type { DashboardGate } from './types/dashboard.types.js';

/**
 * What an event's payload says, in the words a person reads it in: the
 * transition and the verdict on a gate result, the kind and sender of a steer,
 * the summary a session finished with. Ids, hashes and file lists stay in the
 * store — `pup report` is where they are read — and a payload with nothing to
 * say leaves the line as its type and its time.
 *
 * `gate` is the run a `gate_result` event reports, as the snapshot service
 * read it: the verdict here and the stage list on the row come from one
 * reading of the report, and a util does not reach into a service for it.
 * The event is typed by the two fields read, because utils do not import
 * repositories.
 */
export function eventDetail(
  event: { type: string; payload: string },
  gate: DashboardGate | undefined,
): string | undefined {
  const payload = parseJsonOr<Record<string, unknown>>(event.payload, {});
  const text = (key: string): string | undefined => {
    const value = payload[key];
    return typeof value === 'string' ? sanitizeReason(value) : undefined;
  };
  const line = (...parts: (string | undefined)[]): string | undefined =>
    parts.filter(Boolean).join(' · ') || undefined;
  switch (event.type) {
    case 'gate_result': {
      const [from, to] = [text('from'), text('to')];
      const verdict = gate?.passed
        ? 'gate passed'
        : gate && `gate failed${gate.failedStage ? ` at ${gate.failedStage}` : ''}`;
      return line(
        from && to ? `${from} → ${to}` : undefined,
        verdict,
        text('outcome'),
        text('reason'),
      );
    }
    case 'steer': {
      const by = text('by');
      return line(text('kind'), by && `by ${by}`);
    }
    case 'turn_died':
      return line(text('reason'), text('refusal'));
    case 'session_done':
      return text('summary');
    case 'merge': {
      const target = text('target');
      return text('prUrl') ?? (target && `into ${target}`);
    }
    default:
      return text('kind');
  }
}
