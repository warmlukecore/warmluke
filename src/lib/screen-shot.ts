// A written screen, photographed as an owner would first see it, for the
// screen check (lib/ux-review.ts).
//
// Merchants said Luke's screens looked rough, and nothing that reads a
// design as text can see a code broken over two lines or a bar over the
// last row. So the page is drawn by a real browser, headless Chromium,
// inside a Vercel Sandbox: a microVM of its own, started from a snapshot
// with Chromium already in it (scripts/make-screen-snapshot.mjs), with
// every outbound connection denied, and stopped as soon as the pictures
// are read back.
//
// "No browser-run tools" (.agents/skills/ai-stack) still holds: the owner
// approved this browser as an exception. It is our own renderer, called
// by our code on a page our code built; no model can call it, ask it to
// go anywhere, or reach it at all, and with the network denied the page
// it draws has nowhere to go either.
//
// Credentials as code rules have them (lib/code-run.ts): on Vercel the
// function's OIDC identity; elsewhere VERCEL_SANDBOX_TOKEN, VERCEL_TEAM_ID
// and VERCEL_PROJECT_ID. SCREEN_SNAPSHOT_ID names the snapshot.
//
// Callers: src/lib/ux-review.ts.

import { Sandbox } from "@vercel/sandbox";
import { canRunCode, credentials } from "@/lib/code-run";

export type Shot = {
  /** What the screen broke on while it ran (its own errors, calls refused), heard by the page around it. */
  broke?: string[];
  w: number;
  /** The height shot, which on a phone may run past the first screen. */
  h: number;
  /** The picture, base64: a PNG, or a JPEG when that was smaller (mediaType says which). */
  png: string;
  mediaType: "image/png" | "image/jpeg";
};

/** Where the snapshot keeps playwright-core, its Chromium and the app's two faces. */
export const SHOT_DIR = "/vercel/sandbox/shot";

/**
 * Put where the page's fonts go (customViewPage's `fonts`): the shooter
 * swaps it for the app's two faces, read from the snapshot as data, as
 * the app hands them to the frame. A page without it is drawn in the
 * machine's own sans.
 */
export const FACES_HERE = "/*WL_FACES*/";

/** Past this a picture is retaken smaller: it still has to travel to the model. */
const MAX_BYTES = 1_500_000;

/**
 * Inside the machine: open the page at each width, let the screen take
 * its rows and fonts, and photograph it. The screen runs in the page's
 * first frame (ux-review builds it as the app does), and that frame is
 * grown to the screen's own height, so a phone's shot shows the rows
 * below the first screen too, up to what a model reads unshrunk.
 */
export const SHOOTER = `import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { chromium } from "playwright-core";
const job = JSON.parse(readFileSync("job.json", "utf8"));
const face = (name, file) =>
  existsSync(file) ? "@font-face{font-family:" + name + ";src:url(data:font/ttf;base64," + readFileSync(file).toString("base64") + ") format(truetype);font-weight:100 900;font-display:block}" : "";
const faces = face("WL Sans", "fonts/sans.ttf") + face("WL Display", "fonts/display.ttf");
const html = readFileSync("page.html", "utf8").split(${JSON.stringify(FACES_HERE)}).join(faces);
const browser = await chromium.launch();
const out = [];
try {
  for (const [i, { w, h }] of job.widths.entries()) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load" });
    await page.waitForSelector("body[data-ready]", { timeout: 8000 }).catch(() => {});
    const frame = page.frames()[1] ?? page.mainFrame();
    const settle = () => document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await frame.evaluate(settle).catch(() => {});
    await page.waitForTimeout(300);
    const cap = Math.max(h, Math.min(1568, Math.floor(1150000 / w)));
    const tall = await frame.evaluate(() => document.documentElement.scrollHeight).catch(() => h);
    const height = Math.min(Math.max(tall, h), cap);
    await page.evaluate((px) => {
      const f = document.querySelector("iframe");
      if (f) f.style.height = px + "px";
      document.body.style.minHeight = px + "px";
    }, height);
    await page.waitForTimeout(150);
    const clip = { x: 0, y: 0, width: w, height };
    const png = await page.screenshot({ clip, fullPage: true, type: "png" });
    let jpeg = await page.screenshot({ clip, fullPage: true, type: "jpeg", quality: 70 });
    if (Math.min(png.length, jpeg.length) > ${MAX_BYTES}) jpeg = await page.screenshot({ clip, fullPage: true, type: "jpeg", quality: 45 });
    const usePng = png.length <= jpeg.length;
    writeFileSync("out-" + i + ".bin", usePng ? png : jpeg);
    // What broke while it ran, as the page around the screen heard it.
    const broke = await page.evaluate(() => window.__broke || []).catch(() => []);
    out.push({ w, h: height, file: "out-" + i + ".bin", mediaType: usePng ? "image/png" : "image/jpeg", broke });
    await page.close();
  }
} finally {
  await browser.close();
}
writeFileSync("out.json", JSON.stringify(out));`;

/** Whether a screen can be photographed from here at all: a snapshot named, and a sandbox reachable. */
export const canShootScreens = () => !!process.env.SCREEN_SNAPSHOT_ID?.trim() && canRunCode();

const unavailable = (why: string) => new Error(`screens unavailable: ${why}`);

/**
 * The page at each width, photographed in a sandbox of its own. Throws
 * Error("screens unavailable: …") when it cannot be: no snapshot or no
 * credentials, past the time allowed (40 seconds by default), or anything
 * failing on the way. The sandbox is always stopped.
 */
export async function shootScreen(
  html: string,
  opts: { widths: Array<{ w: number; h: number }>; timeoutMs?: number; signal?: AbortSignal }
): Promise<Shot[]> {
  const snapshotId = process.env.SCREEN_SNAPSHOT_ID?.trim();
  if (!snapshotId) throw unavailable("SCREEN_SNAPSHOT_ID is not set");
  if (!canRunCode()) throw unavailable("no sandbox credentials here");
  const timeoutMs = opts.timeoutMs ?? 40_000;
  const stop = new AbortController();
  const late = setTimeout(() => stop.abort(), timeoutMs);
  const caller = () => stop.abort();
  opts.signal?.addEventListener("abort", caller, { once: true });
  const signal = stop.signal;
  // Every step hears the same stop, and the race below gives up on one
  // that does not: the time allowed is the time it takes, at most.
  const given = new Promise<never>((_, no) =>
    signal.addEventListener("abort", () => no(new Error("stopped")), { once: true })
  );
  const work = async (): Promise<Shot[]> => {
    let sandbox: Sandbox | null = null;
    try {
      sandbox = await Sandbox.create({
        ...credentials(),
        source: { type: "snapshot", snapshotId },
        // Where the snapshot was made, beside the function (lib/code-run).
        region: process.env.VERCEL_REGION || "bom1",
        // Ends by itself a little after the caller has stopped waiting.
        timeout: timeoutMs + 15_000,
        resources: { vcpus: 2 },
        networkPolicy: "deny-all",
        // Nothing in it is worth keeping: no snapshot taken when it stops.
        persistent: false,
        signal,
      });
      await sandbox.writeFiles(
        [
          { path: `${SHOT_DIR}/shoot.mjs`, content: Buffer.from(SHOOTER) },
          { path: `${SHOT_DIR}/page.html`, content: Buffer.from(html) },
          { path: `${SHOT_DIR}/job.json`, content: Buffer.from(JSON.stringify({ widths: opts.widths })) },
        ],
        { signal }
      );
      const ran = await sandbox.runCommand({
        cmd: "node",
        args: ["shoot.mjs"],
        cwd: SHOT_DIR,
        env: { PLAYWRIGHT_BROWSERS_PATH: `${SHOT_DIR}/browsers` },
        signal,
        timeoutMs,
      });
      if (ran.exitCode !== 0) throw new Error(`the browser failed: ${(await ran.stderr()).trim().slice(-300)}`);
      const listed = await sandbox.readFileToBuffer({ path: `${SHOT_DIR}/out.json` }, { signal });
      if (!listed) throw new Error("the browser drew nothing");
      const made = JSON.parse(listed.toString("utf8")) as Array<Omit<Shot, "png"> & { file: string }>;
      const shots: Shot[] = [];
      for (const m of made) {
        const picture = await sandbox.readFileToBuffer({ path: `${SHOT_DIR}/${m.file}` }, { signal });
        if (!picture) throw new Error(`the ${m.w}px picture is missing`);
        const broke = Array.isArray(m.broke)
          ? m.broke.filter((x): x is string => typeof x === "string").slice(0, 5)
          : [];
        shots.push({ w: m.w, h: m.h, png: picture.toString("base64"), mediaType: m.mediaType, broke });
      }
      return shots;
    } finally {
      // Not waited for: the pictures are in hand (or never will be), and a
      // machine left running ends by itself at its timeout.
      void sandbox?.stop().catch(() => {});
    }
  };
  try {
    return await Promise.race([work(), given]);
  } catch (e) {
    const why = opts.signal?.aborted
      ? "stopped"
      : signal.aborted
        ? `took longer than ${Math.round(timeoutMs / 1000)} seconds`
        : e instanceof Error
          ? e.message.slice(0, 300)
          : String(e);
    throw unavailable(why);
  } finally {
    clearTimeout(late);
    opts.signal?.removeEventListener("abort", caller);
    stop.abort();
  }
}
