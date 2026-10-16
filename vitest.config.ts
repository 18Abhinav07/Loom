import { defineConfig } from 'vitest/config';

// Only our packages: bench/cache holds a Django checkout whose QUnit files vitest would otherwise collect.
export default defineConfig({ test: { globalSetup: ['./vitest.tmp.ts'], include: ['packages/*/test/**/*.test.ts', 'apps/dashboard/test/**/*.test.ts'] } });
