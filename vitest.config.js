import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    environment: "node",
    testTimeout: 30000,
    // The PGlite (Postgres in WASM) database test can crash its worker when other files run
    // in parallel; the whole suite still finishes in about 15 seconds when run one file at a time.
    fileParallelism: false,
  },
});
