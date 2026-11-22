/**
 * What a `pup init` run may do to the recorded push target (decision 56):
 * `'record'` writes it when nothing is recorded yet and reports a value that
 * disagrees rather than overwriting it, `'re-record'` is the operator's word
 * that origin moved (`pup init --origin-moved`). Both are the operator's: a
 * session cannot reach `pup init` at all (decision 64).
 */
export enum OriginRecording {
  Record = 'record',
  ReRecord = 're-record',
}
