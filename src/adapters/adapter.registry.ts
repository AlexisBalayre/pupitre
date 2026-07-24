import { loadCustomAdapter } from './custom.adapter.js';
import { pythonAdapter } from './python.adapter.js';
import type { Adapter } from './types/adapter.types.js';
import { typescriptAdapter } from './typescript.adapter.js';

/** Order is priority order: the first detected adapter drives single-adapter flows (merge, map). */
export const ADAPTERS: Adapter[] = [typescriptAdapter, pythonAdapter];

/** A repo's `.pupitre/adapter.yml` outranks the built-ins — it exists to override them. */
export function detectAdapters(repoPath: string): Adapter[] {
  const custom = loadCustomAdapter(repoPath);
  const builtIn = ADAPTERS.filter((adapter) => adapter.detect(repoPath));
  return custom ? [custom, ...builtIn] : builtIn;
}
