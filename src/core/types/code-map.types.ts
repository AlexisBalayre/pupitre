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
