import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  webServer: {
    command: 'node e2e/server.cjs',
    port: 3333,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://localhost:3333',
  },
});
