// The Workflow spike, proven on a Vercel preview: the model step dies on
// its first attempt (the platform kills the invocation), the retry
// answers, the run completes. Prints every event with its time. By hand
// only (model tier): needs a preview deployment with LUKE_WORKFLOW=1 on
// the check project, and its protection-bypass secret in a file.
//
//   ENV_FILE=.env.check.local PREVIEW=https://… BYPASS_FILE=<path> \
//     node scripts/check-workflow-spike.mjs [slowMs]
//
// Without PREVIEW it says so and exits 0: nothing to prove here.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";

const root = new URL("../", import.meta.url);
const env = Object.fromEntries(
  readFileSync(new URL(process.env.ENV_FILE ?? ".env.check.local", root), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const PREVIEW = process.env.PREVIEW;
if (!PREVIEW) {
  console.log("PREVIEW is not set; nothing to prove here");
  process.exit(0);
}
const bypass = process.env.BYPASS_FILE ? readFileSync(process.env.BYPASS_FILE, "utf8").trim() : "";
const slowMs = Number(process.argv[2] ?? 0);
// The bypass header on every request; asking for its cookie makes Vercel redirect, and a script has no browser to follow it.
const H = bypass ? { "x-vercel-protection-bypass": bypass } : {};

const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const client = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
const me = await signInAsCheckUser(client, env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const token = me.session.access_token;
const project = await throwawayProject(admin, me.user.id, "workflow proof");
const t0 = Date.now();
const stamp = (at) => `+${((at - t0) / 1000).toFixed(1)}s`;
try {
  const res = await fetch(`${PREVIEW}/api/spike/luke`, {
    method: "POST",
    headers: { ...H, "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ projectId: project.id, message: "hi", slowMs }),
  });
  const runId = res.headers.get("x-workflow-run-id");
  console.log("POST", res.status, "run", runId, "content-type", res.headers.get("content-type"));
  if (!res.ok) {
    console.log(await res.text());
    process.exit(1);
  }
  // Read the live stream until it ends or the route dies under us.
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line) continue;
        const e = JSON.parse(line);
        console.log(stamp(Date.now()), "live", JSON.stringify(e).slice(0, 120));
      }
    }
    console.log(stamp(Date.now()), "live stream ended");
  } catch (e) {
    console.log(stamp(Date.now()), "live stream dropped:", e.message);
  }
  // Then the run itself, read back until it completes.
  for (let i = 0; i < 120; i++) {
    const r = await fetch(`${PREVIEW}/api/spike/luke?run=${runId}`, {
      headers: { ...H, Authorization: `Bearer ${token}` },
    });
    const status = r.headers.get("x-workflow-status");
    if (status === "completed" || status === "failed" || status === "cancelled") {
      console.log(stamp(Date.now()), "run status", status);
      const text = await r.text();
      for (const line of text.split("\n").filter(Boolean)) {
        const e = JSON.parse(line);
        const at = e.at ? ` at ${stamp(e.at)}` : "";
        console.log("  event", JSON.stringify(e).slice(0, 110) + at);
      }
      break;
    }
    console.log(stamp(Date.now()), "run status", status, "… waiting");
    await new Promise((r) => setTimeout(r, 15000));
  }
} finally {
  await project.remove();
}
