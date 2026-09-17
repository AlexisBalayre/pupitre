import { BrokenToolchainError, NoAdapterError } from '../core/init.service.js';

/**
 * Shared by init/audit: both baseline a repo and refuse the same way when no
 * adapter fits, or when the package manager cannot load and nothing was stored
 * (decision 55).
 */
export function runOrReportNoAdapter<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (error) {
    if (error instanceof NoAdapterError || error instanceof BrokenToolchainError) {
      console.error(error.message);
      process.exitCode = 1;
      return undefined;
    }
    throw error;
  }
}
