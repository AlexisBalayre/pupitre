/** One decision record as the sheet reads it, every string through `oneLine`. */
export interface DecisionSheetRecord {
  id: number;
  /** The session id, or `UNMINTED_LABEL` for one outside the minted shape. */
  session: string;
  /** `YYYY-MM-DD` UTC, the day it is grouped under; `NO_DAY` when the stored time does not parse. */
  day: string;
  /** `, YYYY-MM-DD HH:MM UTC`, the day kept in the row so the page's filter finds it; empty when the stored time does not parse. */
  time: string;
  /** Each a line of the stored text, as `pup log` prints it. */
  summary: string[];
  alternatives: string[];
  files: string[];
}
