import { NoAdapterError } from '../core/init.service.js';

/** Shared by init/audit: both baseline a repo and refuse the same way when no adapter fits. */
export function runOrReportNoAdapter<TResult>(fn: () => TResult): TResult | undefined {
  try {
    return fn();
  } catch (error) {
    if (error instanceof NoAdapterError) {
      console.error(error.message);
      process.exitCode = 1;
      return undefined;
    }
    throw error;
  }
}
