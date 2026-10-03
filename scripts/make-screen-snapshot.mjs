// Makes the sandbox snapshot the screen check photographs written screens
// in (lib/screen-shot.ts): Ubuntu with Node, playwright-core and its
// headless Chromium, the libraries Chromium needs, and the app's two
// faces (Manrope and Bricolage Grotesque) so text measures as it does in
// the app. Prints the snapshot's id.
//
// Run once, by hand, and again only when playwright-core or the faces
// change. It is the one sandbox with the network open, to install; the
// ones started from its snapshot have it denied.
//
//   node --env-file=.env.local --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/make-screen-snapshot.mjs
//
// Credentials as code rules have them (lib/code-run.ts): VERCEL_SANDBOX_TOKEN,
// VERCEL_TEAM_ID and VERCEL_PROJECT_ID of the app's own Vercel project, or a
// VERCEL_OIDC_TOKEN from `vercel env pull`. The snapshot lives in that project,
// in one region: the one the functions run in (VERCEL_REGION, else bom1, as the
// shooter asks). Made elsewhere, the shooter cannot find it.
//
// Then set what it prints:
//   locally     SCREEN_SNAPSHOT_ID=snap_… in .env.local (and the check env file);
//   on Vercel   vercel env add SCREEN_SNAPSHOT_ID production (and preview), or the
//               project's Settings → Environment Variables; it is read per call, so
//               the next deploy picks it up.
// The screen check runs only when ANTHROPIC_UX_MODEL is set too; without the
// snapshot it reads a screen's code instead of photographing it.
//
// Cost: one sandbox, 2 vCPUs, for about five to ten minutes (most of it apt and
// the Chromium download), so a few cents of sandbox time at Vercel's published
// Sandbox prices; then the snapshot's storage, about a gigabyte, billed per
// GB-month while it is kept (it is kept until deleted: expiration 0). Check the
// Sandbox pricing page for today's rates. An old snapshot is deleted from the
// dashboard (Sandboxes → Snapshots) once the new id is live.

import { Sandbox } from "@vercel/sandbox";
import { credentials } from "../src/lib/code-run.ts";
import { SHOOTER, SHOT_DIR } from "../src/lib/screen-shot.ts";
import { screenDocument } from "../src/lib/ux-review.ts";

/** The version the app's own end-to-end runs use (package.json @playwright/test). */
const PLAYWRIGHT = "1.63.0";
const FACES = {
  "sans.ttf": "https://github.com/google/fonts/raw/main/ofl/manrope/Manrope%5Bwght%5D.ttf",
  "display.ttf":
    "https://github.com/google/fonts/raw/main/ofl/bricolagegrotesque/BricolageGrotesque%5Bopsz%2Cwdth%2Cwght%5D.ttf",
};
/** What Chromium needs on Ubuntu, for when playwright's install-deps does not know this release. */
const LIBS = [
  "libnss3",
  "libnspr4",
  "libatk1.0-0",
  "libatk-bridge2.0-0",
  "libatspi2.0-0",
  "libcups2",
  "libdrm2",
  "libxkbcommon0",
  "libxcomposite1",
  "libxdamage1",
  "libxfixes3",
  "libxrandr2",
  "libgbm1",
  "libpango-1.0-0",
  "libcairo2",
  "libasound2",
  "libx11-6",
  "libxcb1",
  "libxext6",
];

const region = process.env.VERCEL_REGION || "bom1";
const env = { PLAYWRIGHT_BROWSERS_PATH: `${SHOT_DIR}/browsers` };

console.log(`making the screen snapshot in ${region}`);
const sandbox = await Sandbox.create({
  ...credentials(),
  image: "vercel/sandbox/node:24",
  region,
  timeout: 30 * 60_000,
  resources: { vcpus: 2 },
  persistent: false,
});

/** One step, shown as it runs; a failure stops the script unless it may fail. */
async function step(what, script, { sudo = false, mayFail = false } = {}) {
  console.log(`\n— ${what}`);
  const ran = await sandbox.runCommand({
    cmd: "bash",
    args: ["-lc", script],
    cwd: SHOT_DIR,
    env,
    sudo,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  if (ran.exitCode !== 0 && !mayFail) throw new Error(`${what} failed (exit ${ran.exitCode})`);
  return ran.exitCode === 0;
}

let snapshotted = false;
try {
  // Owned by the sandbox's own user, who writes there on every shot.
  await sandbox.runCommand("mkdir", ["-p", `${SHOT_DIR}/fonts`]);
  await step("the system", "cat /etc/os-release | head -3; node --version");
  await step(
    "playwright-core",
    `npm init -y >/dev/null && npm install --no-audit --no-fund playwright-core@${PLAYWRIGHT}`
  );
  await step("package lists", "apt-get update", { sudo: true });
  const known = await step(
    "Chromium's libraries, as playwright knows them",
    "npx playwright-core install-deps chromium",
    {
      sudo: true,
      mayFail: true,
    }
  );
  if (!known) {
    // A release playwright has no list for: each library by its name, or its
    // name since Ubuntu 24.04 moved many to a "t64" build.
    await step(
      "Chromium's libraries, one by one",
      LIBS.map(
        (p) => `(apt-get install -y --no-install-recommends ${p} || apt-get install -y --no-install-recommends ${p}t64)`
      ).join(" && "),
      { sudo: true }
    );
  }
  await step(
    "fallback faces (₹ and emoji)",
    "apt-get install -y --no-install-recommends fonts-dejavu-core fonts-noto-color-emoji fontconfig",
    {
      sudo: true,
    }
  );
  await step("headless Chromium", "npx playwright-core install --only-shell chromium");
  for (const [file, url] of Object.entries(FACES)) {
    const got = await step(`the app's face ${file}`, `curl -fsSL -o fonts/${file} '${url}'`, { mayFail: true });
    if (!got) console.warn(`  ${file} not fetched: screens fall back to the machine's sans for it`);
  }

  // One screen photographed, as the app will ask, before anything is kept.
  const html = `<div class="wl-page"><h1>Snapshot check</h1><div id=n class="wl-count">0</div></div><script>wl.onRows((r) => { n.textContent = r.length; });</script>`;
  await sandbox.writeFiles([
    { path: `${SHOT_DIR}/shoot.mjs`, content: Buffer.from(SHOOTER) },
    {
      path: `${SHOT_DIR}/page.html`,
      content: Buffer.from(
        screenDocument(
          { title: "Snapshot check", html, columns: [], rows: [{ id: "1", data: {} }] },
          { locale: "en-IN", currency: "INR" }
        )
      ),
    },
    { path: `${SHOT_DIR}/job.json`, content: Buffer.from(JSON.stringify({ widths: [{ w: 390, h: 844 }] })) },
  ]);
  await step("a screen photographed", "node shoot.mjs && cat out.json && echo");
  await step("tidied", "rm -f shoot.mjs page.html job.json out.json out-*.bin && rm -rf ~/.npm");
  await step("apt's lists dropped", "apt-get clean && rm -rf /var/lib/apt/lists/*", { sudo: true });

  // Snapshotting stops the sandbox: nothing to stop after it.
  const snap = await sandbox.snapshot({ expiration: 0 });
  snapshotted = true;
  console.log(`\nSCREEN_SNAPSHOT_ID=${snap.snapshotId}`);
  console.log(`(in ${snap.regions?.join(", ") || region}, ${Math.round((snap.sizeBytes ?? 0) / 1e6)} MB)`);
} finally {
  if (!snapshotted) await sandbox.stop().catch(() => {});
}
