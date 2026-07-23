export interface DiffFileStat {
  path: string;
  /** null for binary files (git reports `-`). */
  added: number | null;
  deleted: number | null;
}
