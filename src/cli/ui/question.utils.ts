import { sanitizeReason } from '../../adapters/capability.utils.js';
import type { EventPayloads } from '../../core/types/session-event.types.js';

/**
 * A question with numbered options as the text surfaces print it (decision
 * 93): what `pup session ask` and `pup conductor ask` echo, and the numbering
 * the inbox shares with `pup answer`.
 */

/**
 * A question's options numbered as `pup answer` reads the number, the
 * recommended one marked, each scrubbed: session-written text bound for the
 * operator's terminal (decision 29). Unindented; the caller places them.
 */
export function optionLines(options: readonly string[], recommended?: number): string[] {
  return options.map(
    (option, index) =>
      `${index + 1}. ${sanitizeReason(option)}${recommended === index + 1 ? '  (recommended)' : ''}`,
  );
}

/** What an asking command echoes: the question as stored, its options numbered under it. */
export function askedLines(who: string, asked: EventPayloads['question']): string[] {
  return [
    `${who} asked: ${sanitizeReason(asked.text)}`,
    ...optionLines(asked.options ?? [], asked.recommended).map((line) => `  ${line}`),
  ];
}
