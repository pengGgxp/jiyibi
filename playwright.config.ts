import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://127.0.0.1:4198/jiyibi/",
    channel: "chrome",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: process.env.CI ? "off" : "retain-on-failure"
  },
  projects: [
    {
      name: "mobile-chrome",
      use: { ...devices["Pixel 7"] }
    },
    {
      name: "tablet-chrome",
      use: {
        ...devices["Galaxy Tab S4"],
        viewport: { width: 1024, height: 768 }
      }
    },
    {
      name: "desktop-chrome",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } }
    }
  ],
  webServer: {
    command: "npm run build && npm run preview -- --host 127.0.0.1 --port 4198 --strictPort",
    env: { VITE_BASE_PATH: "/jiyibi/" },
    url: "http://127.0.0.1:4198/jiyibi/",
    reuseExistingServer: false,
    timeout: 120_000
  }
});
