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
    command: "npm run build && npm run preview",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 180000,
    // No Supabase settings: the e2e suite checks the offline/local behaviour
    env: { VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "" },
  },
});
