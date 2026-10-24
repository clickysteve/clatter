import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

function commit(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  // Relative paths: the same build works at the custom domain root and under /<repo>/.
  base: './',
  server: { port: 5231 },
  worker: { format: 'es' },
  build: { target: 'es2022', assetsInlineLimit: 0 },
  define: {
    __BUILD_COMMIT__: JSON.stringify(process.env.GITHUB_SHA?.slice(0, 7) ?? commit()),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
} as never);
