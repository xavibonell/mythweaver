import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Alias the workspace packages to their TypeScript source so tests run without a
 * prior build. Vite resolves the NodeNext-style `.js` import specifiers to the
 * sibling `.ts` files.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@mythweaver/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
      '@mythweaver/engine': fileURLToPath(new URL('./packages/engine/src/index.ts', import.meta.url)),
      '@mythweaver/llm': fileURLToPath(new URL('./packages/llm/src/index.ts', import.meta.url)),
      '@mythweaver/rag': fileURLToPath(new URL('./packages/rag/src/index.ts', import.meta.url)),
      '@mythweaver/scene': fileURLToPath(new URL('./packages/scene/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
  },
});
