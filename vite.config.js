import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // Relative base so the build also works from a sub-path (e.g. GitHub Pages)
  base: "./",
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: { input: "index.html" },
  },
  plugins: [
    VitePWA({
      registerType: "prompt",
      injectRegister: false, // registered from main.js so we can offer "Update now"
      includeAssets: ["icon.svg", "icon-192.png", "icon-512.png"],
      manifest: {
        name: "Travel Audit",
        short_name: "Travel Audit",
        description: "Track shared travel expenses offline; everyone pays an equal share.",
        theme_color: "#667eea",
        background_color: "#667eea",
        display: "standalone",
        start_url: ".",
        scope: ".",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
        navigateFallback: "index.html",
        // Never cache API traffic: data goes through IndexedDB + the sync engine
        navigateFallbackDenylist: [/^\/rest\//, /^\/auth\//],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
