import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:8899', headless: true },
  webServer: {
    command: 'node tests/server.mjs',
    url: 'http://127.0.0.1:8899',
    reuseExistingServer: !process.env.CI,
  },
});
