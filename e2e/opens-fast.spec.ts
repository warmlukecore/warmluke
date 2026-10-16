// The first chat opens without waiting (the sprint's Days 14–15 target): a
// new owner's first screen is usable within two seconds, while their store
// is still coming in, their website is still being read and Luke has not
// yet said hello. The way out to the store works, and they can type; what
// they type waits for his hello. Measured on a warm page, at both widths:
// the number is printed and kept on the run (annotation "shell_ms").
import { expect, test } from "./shop";

/** The sprint's target: a miss is reported, never hidden (it is printed and kept on the run). */
const TARGET_MS = 2_000;
/** What is held below never comes: a screen that waited on any of it would never open. */
const NEVER_MS = 8_000;
const THREAD = "00000000-0000-4000-8000-0000000fa57e";

test("the first chat is usable at once while the store, the website and Luke are all still slow", async ({
  signedIn: page,
  shop,
}) => {
  const { data: had } = await shop.admin.from("profiles").select("*").eq("user_id", shop.userId).maybeSingle();
  await shop.admin.from("profiles").upsert({
    user_id: shop.userId,
    full_name: "Asha Rao",
    business_name: "Asha Crafts",
    role: "founder",
    monthly_orders: "under_500",
    platform: "shopify",
    website: "ashacrafts.example",
    onboarded_at: new Date().toISOString(),
  });
  await shop.admin.from("profiles").update({ met_luke_at: null }).eq("user_id", shop.userId);
  // Enrichment held: one list still coming across, the website read slow, Luke's hello not yet said.
  await shop.admin
    .from("import_runs")
    .update({ status: "running" })
    .eq("store_id", shop.storeId)
    .eq("resource", "customers");
  await page.route("**/api/site-read", async (route) => {
    await new Promise((r) => setTimeout(r, 10_000));
    await route.fulfill({ json: { skipped: "held by the test" } });
  });
  // His hello held until the test lets it go: what is measured is everything before it.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/chat", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await held;
    await route
      .fulfill({
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
        body:
          [
            { step: "accepted", conversationId: THREAD, turn: null },
            { reply: { type: "answer", kind: "conversation", message: "Hi, I'm Luke." }, conversationId: THREAD },
          ]
            .map((l) => JSON.stringify(l))
            .join("\n") + "\n",
      })
      .catch(() => {
        // The first page's hello, gone with the page that asked it.
      });
  });
  try {
    const luke = page.getByRole("complementary", { name: "Luke" });
    const out = luke.getByRole("button", { name: "Go to store" });
    const box = page.getByPlaceholder("Luke is saying hello… you can start typing");
    // A first load to warm the page (a dev server compiles what it serves the first time).
    await page.goto(`/app/${shop.projectId}`);
    await expect(out).toBeVisible({ timeout: 30_000 });

    const started = Date.now();
    await page.goto(`/app/${shop.projectId}`);
    await expect(out).toBeEnabled();
    await expect(box).toBeEditable();
    const ms = Date.now() - started;
    test.info().annotations.push({ type: "shell_ms", description: String(ms) });
    console.log(
      `first chat usable in ${ms} ms (${test.info().project.name}): ${ms <= TARGET_MS ? "inside" : "OVER"} the ${TARGET_MS} ms target`
    );
    expect(ms).toBeLessThan(NEVER_MS);

    // Typed into at once; sent only once he has spoken, and what was typed is kept.
    await box.fill("Returns eat my day");
    await box.press("Enter");
    await expect(box).toHaveValue("Returns eat my day");
    release();
    await expect(luke.getByText("Hi, I'm Luke.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByPlaceholder("Reply to Luke, in your own words")).toHaveValue("Returns eat my day");
    await expect(luke.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  } finally {
    await shop.admin
      .from("import_runs")
      .update({ status: "done" })
      .eq("store_id", shop.storeId)
      .eq("resource", "customers");
    if (had) await shop.admin.from("profiles").upsert(had);
    else await shop.admin.from("profiles").delete().eq("user_id", shop.userId);
  }
});
