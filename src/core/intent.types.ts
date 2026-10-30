import type { IntentStatus } from './intent.enums.js';

/** One intent file as `readIntent` parsed it (decision 126). */
export interface Intent {
  /** Four digits, the file name's prefix and the number on its title line. */
  id: string;
  title: string;
  status: IntentStatus;
  /** Absolute path of the file under `docs/intent/`. */
  path: string;
  /** The file's text with control characters stripped, keeping newline and tab. */
  text: string;
  /** The list items under "What I must understand after review" that end in `?`. */
  questions: string[];
}

/**
 * One row of `listIntents`: the intent, or why its file could not be read, so
 * a malformed file is listed as one rather than hidden or failing the list.
 */
export type IntentListEntry = { id: string; intent: Intent } | { id: string; unreadable: string };
