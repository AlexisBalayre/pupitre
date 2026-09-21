import { describe, expect, it } from 'vitest';
import { isInNestedPackage } from './typescript-source.utils.js';

describe('isInNestedPackage', () => {
  it('matches a file at any depth inside a nested package and nothing beside it', () => {
    const nested = new Set(['packages/api']);

    expect(isInNestedPackage('packages/api/src/deep/server.ts', nested)).toBe(true);
    expect(isInNestedPackage('packages/api-client/src/app.ts', nested)).toBe(false);
    expect(isInNestedPackage('packages/web/src/app.ts', nested)).toBe(false);
    expect(isInNestedPackage('main.ts', nested)).toBe(false);
  });
});
