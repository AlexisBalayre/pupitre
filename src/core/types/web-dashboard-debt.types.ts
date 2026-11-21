/** One open ledger entry as the Debt sheet reads it, every string already through `oneLine`. */
export interface DebtSheetEntry {
  id: string;
  description: string;
  reason: string;
  acceptedBy: string;
  reviewBy: string;
  /** The files it names, each once; empty when it names none. */
  files: string[];
  /** Whole days since it was filed. */
  ageDays: number;
  overdue: boolean;
}

/** A file on the pay-down ranking: its open entries, oldest first, and what they weigh together. */
export interface RankedFile {
  file: string;
  weight: number;
  entries: DebtSheetEntry[];
}
