import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { trace: 'off', video: 'off', screenshot: 'off' },
  webServer: {
    command: 'node scripts/demo-server.mjs',
    url: 'http://127.0.0.1:4173/basic.html',
    reuseExistingServer: true,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
