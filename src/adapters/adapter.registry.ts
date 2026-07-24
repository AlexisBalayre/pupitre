import { pythonAdapter } from './python.adapter.js';
import type { Adapter } from './types/adapter.types.js';
import { typescriptAdapter } from './typescript.adapter.js';

/** Order is priority order: the first detected adapter drives single-adapter flows (merge, map). */
export const ADAPTERS: Adapter[] = [typescriptAdapter, pythonAdapter];

export function detectAdapters(repoPath: string): Adapter[] {
  return ADAPTERS.filter((adapter) => adapter.detect(repoPath));
}
