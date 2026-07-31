/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["favicon.svg", "icons/apple-touch-icon.png"],
      manifest: {
        name: "记一笔",
        short_name: "记一笔",
        description: "本地优先、可选云同步的极速收支记录工具",
        lang: "zh-CN",
        start_url: ".",
        scope: ".",
        display: "standalone",
        orientation: "any",
        background_color: "#f4f6f5",
        theme_color: "#17211d",
        categories: ["finance", "productivity"],
        icons: [
          {
            src: "icons/pwa-192.png",
            sizes: "192x192",
            type: "image/png"
          },
          {
            src: "icons/pwa-512.png",
            sizes: "512x512",
            type: "image/png"
          },
          {
            src: "icons/pwa-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable"
          }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        navigateFallbackDenylist: [
          /^\/api(?:\/|$)/,
          /^\/cdn-cgi\/access(?:\/|$)/,
        ],
        runtimeCaching: [
          {
            urlPattern: /\/api(?:\/|$)/,
            handler: "NetworkOnly",
            method: "GET"
          },
          {
            urlPattern: /\/cdn-cgi\/access(?:\/|$)/,
            handler: "NetworkOnly",
            method: "GET"
          }
        ]
      },
      devOptions: {
        enabled: true,
        navigateFallback: "index.html"
      }
    })
  ],
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    include: ["src/**/*.test.{ts,tsx}", "functions/**/*.test.ts"]
  }
});
