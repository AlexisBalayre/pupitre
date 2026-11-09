import { sanitizeReason } from '../../adapters/capability.utils.js';
import { MAX_QUESTION_OPTIONS } from '../../core/session.repository.js';
import { QuestionRefusedError } from '../../core/session-lifecycle.service.js';
import type { EventPayloads } from '../../core/types/session-event.types.js';

/**
 * A question with numbered options as the text surfaces read and write it
 * (decision 93): what `pup session ask` and `pup conductor ask` store, what
 * they echo, and the numbering the inbox shares with `pup answer`.
 */

/** `pup session ask`'s and `pup conductor ask`'s options, as commander hands them in. */
export interface AskOptions {
  option?: string[];
  recommend?: string;
}

/**
 * The question an asking command stores: its text, up to
 * `MAX_QUESTION_OPTIONS` options, and `--recommend` naming one of them by its
 * 1-based number. Refused with `QuestionRefusedError` before anything is stored.
 */
export function askedQuestion(
  command: string,
  text: string | undefined,
  opts: AskOptions,
): EventPayloads['question'] {
  const options = opts.option ?? [];
  if (!text?.trim()) throw new QuestionRefusedError(`${command} needs the question itself.`);
  if (options.length > MAX_QUESTION_OPTIONS) {
    throw new QuestionRefusedError(
      `A question offers at most ${MAX_QUESTION_OPTIONS} options, one key each; ask it in words, or fewer.`,
    );
  }
  if (options.some((option) => !option.trim())) {
    throw new QuestionRefusedError('Every --option needs its text.');
  }
  if (opts.recommend === undefined) return { text, ...(options.length > 0 ? { options } : {}) };
  const recommended = Number(opts.recommend);
  if (!/^\d+$/.test(opts.recommend) || recommended < 1 || recommended > options.length) {
    throw new QuestionRefusedError(
      `--recommend takes the number of one of the ${options.length} options, from 1.`,
    );
  }
  return { text, options, recommended };
}

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
