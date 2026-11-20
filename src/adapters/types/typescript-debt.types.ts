/** Which exports the repo imports, gathered across every file's imports. */
export interface UsageMarks {
  /** `file\0exportName` pairs imported somewhere in the repo. */
  used: Set<string>;
  /** Files whose whole export surface counts as used (namespace import, `export *`, side-effect import). */
  fullyUsed: Set<string>;
}

/** A source line kept for duplicate-window matching, trimmed and numbered. */
export interface NormalizedLine {
  text: string;
  /** 1-based line number in the original file. */
  line: number;
}
