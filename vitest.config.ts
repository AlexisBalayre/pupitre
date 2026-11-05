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
    // Both trees while the tests move out of src/ (decision 116).
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
