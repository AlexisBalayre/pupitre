import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoAdapterError } from '../core/init.service.js';
import { runOrReportNoAdapter } from './no-adapter-guard.utils.js';

describe('runOrReportNoAdapter', () => {
  const originalExitCode = process.exitCode;
  let errors: string[];
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    process.exitCode = undefined;
    errors = [];
    originalConsoleError = console.error;
    console.error = (message: string) => errors.push(message);
  });

  afterEach(() => {
    console.error = originalConsoleError;
    process.exitCode = originalExitCode;
  });

  it('returns the result when fn succeeds', () => {
    const result = runOrReportNoAdapter(() => 'report');

    expect(result).toBe('report');
    expect(process.exitCode).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it('reports NoAdapterError to stderr and sets exit code 1', () => {
    const error = new NoAdapterError('/repo');
    const result = runOrReportNoAdapter(() => {
      throw error;
    });

    expect(result).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(errors).toEqual([error.message]);
  });

  it('rethrows any other error unchanged', () => {
    const other = new Error('boom');

    expect(() =>
      runOrReportNoAdapter(() => {
        throw other;
      }),
    ).toThrow(other);
    expect(process.exitCode).toBeUndefined();
    expect(errors).toEqual([]);
  });
});
