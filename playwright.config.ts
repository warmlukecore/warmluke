// The app in a real browser, at the two widths every screen is walked at.
//
// Against a server that is already up (CI's serve step, or your own
// `next dev -p 3101` with APP_URL): this starts none, so what is tested
// is the build that is running. Luke's answers play back from tapes/
// (model-tape.ts), so the server must run with MODEL_TAPE=replay, or
// record, and the specs refuse one that does not. One worker: the specs
// share the check user, and its per-hour limits, with the live checks.
//
//   ENV_FILE=.env.check.local APP_URL=http://localhost:3101 pnpm exec playwright test

import { defineConfig } from "@playwright/test";

// One clock for the specs and the browser they drive: the merchants'. A
// spec that works out "yesterday" in Node and a page that shows it in the
// browser disagreed for five and a half hours a night on CI, whose runner
// is on UTC (15 Oct). The workers inherit it.
process.env.TZ = "Asia/Kolkata";

export default defineConfig({
  testDir: "e2e",
  workers: 1,
  fullyParallel: false,
  // Played back, a Luke turn takes a second; recorded against real
  // models that are busy and falling back, one has taken six minutes.
  timeout: process.env.MODEL_TAPE === "record" ? 900_000 : 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.APP_URL ?? "http://localhost:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // The same clock in the browser (TZ above is the specs').
    timezoneId: "Asia/Kolkata",
  },
  projects: [
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } },
    {
      name: "phone",
      use: { browserName: "chromium", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
});
