import { defineConfig } from 'vitest/config';

// Time budgets, run on their own after the main suite: measured beside the other test files they would time the runner.
export default defineConfig({ test: { include: ['packages/*/test/**/*.perf.ts'], fileParallelism: false } });
