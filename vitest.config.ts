import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@src': fileURLToPath(new URL('./src', import.meta.url)),
      '@test': fileURLToPath(new URL('./test', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    // Many tests spawn real git and sh; a worker per core, times several suites at once, swamps
    // the machine and times those tests out. Half the cores, at least two.
    maxWorkers: Math.max(2, Math.floor(availableParallelism() / 2)),
  },
});
