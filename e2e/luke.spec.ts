// Luke, asked in the panel, answering from the shop and asking before it changes it.
//
// The answers play back from tapes/. A spec asked in new words, or a
// prompt that changed, finds no recording and fails with the server's
// "[tape] no recording" line saying why: record again with the server
// and this both on MODEL_TAPE=record (tapes/README.md).
import type { Locator, Page } from "@playwright/test";
import { LUKE_COPY } from "@/lib/luke-copy";
import { TAPE, expect, test } from "./shop";

/** How long a turn may take: a second played back, minutes recorded against busy models. */
const TURN_MS = TAPE === "record" ? 600_000 : 30_000;

/** Luke's panel, opened: below the wide layout (lg, 1024px) it is a drawer behind a button. */
async function luke(page: Page) {
  // Ready once the shop's figures are in: before that the page may still
  // be hydrating, and React replaces whatever was typed.
  await expect(page.getByRole("img", { name: /Orders per day/ })).toBeVisible();
  const panel = page.getByRole("complementary", { name: "Luke" });
  const box = panel.getByPlaceholder(LUKE_COPY.placeholder);
  if ((page.viewportSize()?.width ?? 0) < 1024) await page.getByRole("button", { name: /^Luke/ }).first().click();
  await expect(box).toBeInViewport();
  return { panel, box };
}

/**
 * A finished turn's trace line ("Read your store · … · 3s"): the summary
 * above the reply, which exists only once the turn is over. The working
 * line says some of the same words while it runs ("Asked for your yes:
 * …"), and a spec that stopped there closed the page on a turn that had
 * not finished, so its last answer was never recorded.
 */
const finished = (panel: Locator, words: string | RegExp) =>
  panel.locator("details > summary", { hasText: words }).first();

/** The turn ended in a reply, not in "Luke could not reach its model". */
async function answered(panel: Locator) {
  await expect(panel.getByText(/could not reach|could not be reached/i)).toHaveCount(0);
}

/**
 * Sends a message and checks the server answers from the tapes. The
 * turn is over when the panel says so (its trace line), not when the
 * network does: a streamed response is not reliably seen to finish.
 */
async function ask(page: Page, box: Locator, message: string) {
  const turn = page.waitForResponse((r) => r.url().endsWith("/api/chat") && r.request().method() === "POST");
  await box.fill(message);
  await expect(box).toHaveValue(message);
  await box.press("Enter");
  const res = await turn;
  expect(res.status(), "the turn was taken").toBe(200);
  expect(res.headers()["x-model-tape"], `the server ${TAPE === "replay" ? "plays back" : "records"} its models`).toBe(
    TAPE
  );
}

test("a question is answered from the shop's own orders", async ({ signedIn: page, shop }) => {
  await page.goto(`/app/${shop.projectId}`);
  const { panel, box } = await luke(page);
  await ask(page, box, "Which orders are still waiting for payment?");
  // The trace of where the answer came from, and the two cash-on-delivery orders the seed holds.
  const trace = finished(panel, "Read your store");
  await expect(trace).toBeVisible({ timeout: TURN_MS });
  await answered(panel);
  await expect(panel.getByText(/#1006/).last()).toBeVisible();
  await expect(panel.getByText(/#1008/).last()).toBeVisible();
  // The new thread joins the switcher, and the trace survives the reload
  // a finished turn sets off (it touches the thread, which the panel
  // watches): the saved rows carry none, and it vanished a second later.
  // Set off here, because for a new thread that reload is a race.
  await expect(panel.getByRole("button", { name: "Past conversations" })).toContainText("1");
  const reloaded = page.waitForResponse((r) => /\/api\/chat\?.*[?&]id=/.test(r.url()));
  await shop.admin
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("project_id", shop.projectId);
  await reloaded;
  await expect(trace).toBeVisible();
});

test("a change to the shop waits for a yes", async ({ signedIn: page, shop }) => {
  // The switch is per account and off by default; on for this test only.
  const { data: before } = await shop.admin
    .from("account_settings")
    .select("store_actions_enabled")
    .eq("user_id", shop.userId)
    .single();
  await shop.admin.from("account_settings").update({ store_actions_enabled: true }).eq("user_id", shop.userId);
  try {
    await page.goto(`/app/${shop.projectId}`);
    const { panel, box } = await luke(page);
    await ask(page, box, "Tag order #1003 as VIP");
    await expect(finished(panel, "asked for your yes")).toBeVisible({ timeout: TURN_MS });
    await answered(panel);
    // Asked for, not done: one request waiting, and nothing applied.
    const { data: asked } = await shop.admin
      .from("store_actions")
      .select("action, status, summary")
      .eq("project_id", shop.projectId);
    expect(asked?.map((a) => a.action)).toEqual(["add_tags"]);
    expect(asked?.[0]?.status).toBe("pending");
    const bell = page.locator('button[title="What your AI asked for"]:visible').first();
    await expect(bell).toHaveAttribute("aria-label", /want your attention/);
    await bell.click();
    await expect(page.getByText(asked?.[0]?.summary ?? "#1003").first()).toBeVisible();
  } finally {
    await shop.admin
      .from("account_settings")
      .update({ store_actions_enabled: before?.store_actions_enabled ?? false })
      .eq("user_id", shop.userId);
    await shop.admin.from("store_actions").delete().eq("project_id", shop.projectId);
  }
});

/** A section to build, as Luke would plan it. */
const newSection = (name: string, label: string) => ({
  changeType: "NEW_MODULE",
  targetModuleId: null,
  newModule: { name, nav_label: label, icon: "table" },
  newSchema: { columns: [{ field: "note", label: "Note", type: "text" }], view: { type: "table" } },
  explanation: `Somewhere to keep ${label.toLowerCase()}.`,
});

type Shop = Parameters<Parameters<typeof test>[2]>[0]["shop"];

/**
 * A thread whose last reply is a design with several plans, saved as a
 * turn saves it. No model: the reply is written here, and building it
 * is a direct apply.
 */
async function designThread(shop: Shop, plans: unknown[]) {
  const { data: thread } = await shop.admin
    .from("conversations")
    .insert({ project_id: shop.projectId, title: "A design" })
    .select("id")
    .single();
  const t = Date.now();
  await shop.admin.from("messages").insert([
    {
      conversation_id: thread!.id,
      role: "user",
      content: "okey do that then",
      payload: { kind: "user", text: "okey do that then" },
      created_at: new Date(t).toISOString(),
    },
    {
      conversation_id: thread!.id,
      role: "assistant",
      content: "",
      payload: { type: "plans", message: "This adds the sections.", plans },
      created_at: new Date(t + 1).toISOString(),
    },
  ]);
  return thread!.id as string;
}

const sectionsNamed = async (shop: Shop, names: string[]) =>
  ((await shop.admin.from("modules").select("name").eq("project_id", shop.projectId).in("name", names)).data ?? [])
    .map((m) => m.name)
    .sort();

async function clearUp(shop: Shop, thread: string, names: string[]) {
  await shop.admin.from("modules").delete().eq("project_id", shop.projectId).in("name", names);
  await shop.admin.from("conversations").delete().eq("id", thread);
}

test("two changes in one reply stay up for a yes when the thread reloads", async ({ signedIn: page, shop }) => {
  // Reloaded, a reply with more than one plan came back as a line of
  // text, and a finished turn reloads the thread (it touches the
  // conversation, which the panel watches), so the card was gone a
  // second after it appeared.
  const names = ["e2e-suppliers", "e2e-reorders"];
  const thread = await designThread(shop, [newSection(names[0], "Suppliers"), newSection(names[1], "Reorders")]);
  try {
    await page.goto(`/app/${shop.projectId}`);
    const { panel } = await luke(page);
    const build = panel.getByRole("button", { name: "Build these 2" });
    await expect(build).toBeVisible();
    await expect(panel.locator('[data-status="ready"]')).toHaveCount(2);
    // What the end of a turn does to the thread, and the reload it sets off.
    const reload = page.waitForResponse((r) => r.url().includes(`id=${thread}`) && r.request().method() === "GET");
    await shop.admin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", thread);
    await reload;
    await expect(build).toBeVisible();
    await build.click();
    await expect(build).toHaveCount(0);
    // Each plan says it was built, on the card that asked for it.
    await expect(panel.locator('[data-status="built"]')).toHaveCount(2);
    await expect(panel.locator('[data-status="built"]').first()).toContainText("Built");
    await expect.poll(() => sectionsNamed(shop, names)).toEqual([...names].sort());
  } finally {
    await clearUp(shop, thread, names);
  }
});

test("a design that does not fit says which part, and leaves nothing half built", async ({ signedIn: page, shop }) => {
  // Two plans making the same section: the first builds, the second is
  // refused, and the first is put back, because a design stands whole
  // or not at all. The card used to go quiet and leave "did not fit"
  // to a line below it.
  const thread = await designThread(shop, [newSection("e2e-twice", "Twice"), newSection("e2e-twice", "Twice again")]);
  try {
    await page.goto(`/app/${shop.projectId}`);
    const { panel } = await luke(page);
    await panel.getByRole("button", { name: "Build these 2" }).click();
    await expect(panel.locator('[data-status="refused"]')).toContainText("Did not fit");
    await expect(panel.locator('[data-status="put-back"]')).toContainText("Put back");
    expect(await sectionsNamed(shop, ["e2e-twice"])).toEqual([]);
    // Nor in the sidebar, which heard the section made and not put back.
    await expect(page.getByText("Twice", { exact: true })).toHaveCount(0);
  } finally {
    await clearUp(shop, thread, ["e2e-twice"]);
  }
});

test("a design part that is already built is left out, not built twice", async ({ signedIn: page, shop }) => {
  const names = ["e2e-there", "e2e-new"];
  const thread = await designThread(shop, [newSection(names[0], "There"), newSection(names[1], "New")]);
  try {
    // Built since the design was written, the way the app builds it.
    const made = await page.request.post("/api/apply", {
      headers: { Authorization: `Bearer ${(shop.session as { access_token: string }).access_token}` },
      data: { projectId: shop.projectId, plans: [newSection(names[0], "There")] },
    });
    expect(made.ok(), "the first section was built").toBe(true);
    await page.goto(`/app/${shop.projectId}`);
    const { panel } = await luke(page);
    await expect(panel.locator('[data-status="already-there"]')).toContainText("Already in your app");
    // Only what is left is offered.
    await panel.getByRole("button", { name: "Build this" }).click();
    await expect(panel.locator('[data-status="built"]')).toHaveCount(1);
    await expect.poll(() => sectionsNamed(shop, names)).toEqual([...names].sort());
  } finally {
    await clearUp(shop, thread, names);
  }
});
