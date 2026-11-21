/**
 * What `pup project dormant|wake` answers: a line for stdout, or the refusal
 * the CLI prints on stderr with exit 1. Nothing is written on a refusal.
 */
export type DormancyOutcome = { said: string } | { refusal: string };
