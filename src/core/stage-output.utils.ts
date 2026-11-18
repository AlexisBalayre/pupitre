import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { failureSummary } from '../adapters/capability.utils.js';
import { writeStoreFile } from './paths.utils.js';

/**
 * Keep a failed stage's whole output, each failed run of it in turn, in
 * `<dir>/<stage>-output.log`, since its detail keeps only the tail; answers
 * the clause saying where, or why it was not kept. The gate keeps its test
 * stage's in the session's directory, a baseline's in the project's. Written as
 * every file pup owns under the store is (`writeStoreFile`, decision 194), only
 * into a directory pup made, never one this makes. The stage's next failure
 * overwrites it, so the store holds one file per stage, not one per run.
 */
export function keepFullOutput(dir: string, stage: string, outputs: string[]): string {
  if (!existsSync(dir)) return `full output not kept: no directory at ${dir}`;
  const name = stage.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  const path = join(dir, `${name}-output.log`);
  const output = outputs
    .map(
      (run, i) => (outputs.length > 1 ? `--- run ${i + 1} of ${outputs.length} ---\n` : '') + run,
    )
    .join('\n\n');
  try {
    writeStoreFile(path, `${output}\n`);
    return `full output: ${path}`;
  } catch (error) {
    return `full output not kept: ${failureSummary(error)}`;
  }
}
