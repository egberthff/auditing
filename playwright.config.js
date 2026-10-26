import { defineConfig } from "@playwright/test";

// Runs against the production build (service worker included) served by `vite preview`.
// Uses the installed Google Chrome by default; set PW_CHANNEL="" to use Playwright's Chromium.
export default defineConfig({
  testDir: "e2e",
  timeout: 60000,
  fullyParallel: false,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:4173",
    channel: process.env.PW_CHANNEL === undefined ? "chrome" : process.env.PW_CHANNEL || undefined,
    headless: true,
  },
  webServer: {
    // --mode e2e reads .env.e2e, which leaves Supabase unset even if .env has real settings
    command: "npx vite build --mode e2e && npm run preview",
    url: "http://localhost:4173", // the local preview server started above (not the deployed site)
    reuseExistingServer: !process.env.CI,
    timeout: 180000,
  },
});
