export interface CodeMapNode {
  /** Repo-relative directory, `/`-separated; `(root)` for top-level files. */
  id: string;
  files: string[];
  /** Commits touching this module in the churn window. */
  churn: number;
  /** Open ledger entries naming a file in this module. */
  openDebt: number;
  dependsOn: string[];
  usedBy: string[];
}

/** One node of the JSON payload embedded in the `pup map --open` HTML. */
export interface MindMapNodeDatum {
  id: string;
  files: string[];
  churn: number;
  openDebt: number;
  dependsOn: string[];
  records: { id: number; summary: string; createdAt: string }[];
}
