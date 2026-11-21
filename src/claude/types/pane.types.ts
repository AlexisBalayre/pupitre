import type { InputBoxState } from '../enums/input-box-state.enums.js';
/** One captured row, escapes removed. */
export interface PaneRow {
  /** Every character the row shows — the structure is read from this. */
  text: string;
  /**
   * The same row with each dim character blanked, so offsets into `text` still
   * hold: what the row shows minus what Claude Code only suggests.
   */
  typed: string;
}

/** One look at the box: its state, and the draft it shows when it holds one. */
export interface InputBoxLook {
  state: InputBoxState;
  /**
   * The draft's text with every space and line break dropped, so one draft
   * reads the same however the pane wraps it: `pup attach` resizes the
   * conductor's window to the operator's terminal (decision 168). Empty
   * unless the box holds text.
   */
  draft: string;
}
