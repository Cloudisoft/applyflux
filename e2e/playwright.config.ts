import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests: real Chromium + the built ApplyFlux Agent extension +
 * the real API + PostgreSQL, against the ApplyFlux Sandbox mock employer.
 * Never points at real employers.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.e2e\.ts/,
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
});
