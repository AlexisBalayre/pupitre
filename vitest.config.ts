import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Many tests spawn real git and sh; a worker per core, times several suites at once, swamps
    // the machine and times those tests out. Half the cores, at least two.
    maxWorkers: Math.max(2, Math.floor(availableParallelism() / 2)),
  },
});
