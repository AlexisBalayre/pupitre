/** Two live sessions whose branch diffs touch at least one identical file. */
export interface OverlapPair {
  sessionA: string;
  sessionB: string;
  files: string[];
}
