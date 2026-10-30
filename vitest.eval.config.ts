import { defineConfig } from 'vitest/config';

/** The development-time kit evaluator (eval/kits.eval.ts). Run with `npm run eval:kits`. */
export default defineConfig({ test: { include: ['eval/**/*.eval.ts'], environment: 'node', testTimeout: 3_600_000, hookTimeout: 3_600_000 } });
