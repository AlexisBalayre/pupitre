/** Coverage of the added/modified lines only; ratio = covered / instrumented. */
export interface PatchCoverage {
  covered: number;
  instrumented: number;
  uncovered: { file: string; line: number }[];
}
