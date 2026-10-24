import { defineConfig } from 'vite';

export default defineConfig({
  // Relative paths: the same build works at the custom domain root and under /<repo>/.
  base: './',
  server: { port: 5231 },
  worker: { format: 'es' },
  build: { target: 'es2022', assetsInlineLimit: 0 },
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
} as never);
