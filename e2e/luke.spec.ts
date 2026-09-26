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

/** How far a message sits below the top of the list that scrolls it, in pixels. */
const belowListTop = (bubble: Locator) =>
  bubble.evaluate((el) => {
    let list = el.parentElement;
    while (list && getComputedStyle(list).overflowY !== "auto") list = list.parentElement;
    return list ? Math.round(el.getBoundingClientRect().top - list.getBoundingClientRect().top) : -1;
  });

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
  // The question is pinned near the top of the list, and stays put while
  // the reply arrives below it and when the thread is read again: it
  // used to jump as the list was pulled to the bottom on every word.
  const bubble = panel.locator(".group").filter({ hasText: "Which orders are still waiting for payment?" }).last();
  const offset = () => belowListTop(bubble);
  await expect.poll(offset).toBeLessThan(40);
  // The trace of where the answer came from, and the two cash-on-delivery orders the seed holds.
  const trace = finished(panel, "Read your store");
  await expect(trace).toBeVisible({ timeout: TURN_MS });
  const pinned = await offset();
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
  expect(Math.abs((await offset()) - pinned), "the question did not move").toBeLessThanOrEqual(2);
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
    // Asked under a long answer, the question still goes to the top and
    // stays there: this is where the list used to jump, pulled to the
    // bottom and back as the reply came in.
    const bubble = panel.locator(".group").filter({ hasText: "Tag order #1003 as VIP" }).last();
    const offset = () => belowListTop(bubble);
    await expect.poll(offset).toBeLessThan(40);
    await expect(finished(panel, "asked for your yes")).toBeVisible({ timeout: TURN_MS });
    expect(await offset(), "the question stayed where it was pinned").toBeLessThan(40);
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
  return replyThread(shop, { type: "plans", message: "This adds the sections.", plans }, "okey do that then");
}

/** A thread whose last reply is this one, saved as a turn saves it: no model involved. */
async function replyThread(shop: Shop, reply: Record<string, unknown>, asked = "Which orders are still unpaid?") {
  const { data: thread } = await shop.admin
    .from("conversations")
    .insert({ project_id: shop.projectId, title: "A reply" })
    .select("id")
    .single();
  const t = Date.now();
  await shop.admin.from("messages").insert([
    {
      conversation_id: thread!.id,
      role: "user",
      content: asked,
      payload: { kind: "user", text: asked },
      created_at: new Date(t).toISOString(),
    },
    {
      conversation_id: thread!.id,
      role: "assistant",
      content: "",
      payload: reply,
      created_at: new Date(t + 1).toISOString(),
    },
  ]);
  return thread!.id as string;
}

/** What the panel sends next, caught before any model is asked. */
function catchNextTurn(page: Page) {
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/chat") && r.method() === "POST");
  void page.route("**/api/chat", (route) => (route.request().method() === "POST" ? route.abort() : route.fallback()));
  return sent.then((r) => (r.postDataJSON() as { message?: string }).message ?? "");
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
    // In the sidebar only: the card names the part "Twice" too.
    await expect(page.locator("nav").getByText("Twice", { exact: true })).toHaveCount(0);
  } finally {
    await clearUp(shop, thread, ["e2e-twice"]);
  }
});

test("a build carries on when the app is closed mid-way, and the thread says how it ended", async ({
  signedIn: page,
  shop,
}) => {
  // The receipt was written by the browser once it heard back, so a tab
  // closed mid-build left none, and the card came back offering to build
  // again what was already built. The server writes it into the thread now.
  const names = ["e2e-away-one", "e2e-away-two"];
  const thread = await designThread(shop, [newSection(names[0], "Away one"), newSection(names[1], "Away two")]);
  try {
    await page.goto(`/app/${shop.projectId}`);
    const { panel } = await luke(page);
    const sent = page.waitForRequest((r) => r.url().endsWith("/api/apply") && r.method() === "POST");
    await panel.getByRole("button", { name: "Build these 2" }).click();
    await sent;
    // Gone before the answer came back: the tab closed the moment the
    // request left, and the build carries on without it.
    await page.reload();
    const { panel: back } = await luke(page);
    // Read from the thread: each part built, and nothing offered twice.
    await expect(back.locator('[data-status="built"]')).toHaveCount(2, { timeout: 30_000 });
    await expect(back.getByRole("button", { name: "Build these 2" })).toHaveCount(0);
    await expect.poll(() => sectionsNamed(shop, names)).toEqual([...names].sort());
  } finally {
    await clearUp(shop, thread, names);
  }
});

test("an answer reads as Markdown, and what to ask next is sent as written", async ({ signedIn: page, shop }) => {
  const thread = await replyThread(shop, {
    type: "answer",
    kind: "store",
    message:
      'Two orders are still unpaid, together **₹2,952**.\n\n### Waiting for payment\n- **#1008** · Rohan Gupta\n- **#1006** · Kabir Singh\n\n<img src=x onerror="window.__hit=1"><script>window.__hit=2</script>',
    next: [
      { label: "Remind me daily", prompt: "Remind me every morning about COD orders that are still unpaid" },
      { label: "Only shipped ones", prompt: "Show me only the unpaid orders that have already shipped" },
    ],
  });
  try {
    await page.goto(`/app/${shop.projectId}`);
    const { panel } = await luke(page);
    // Headings, bullets and bold, as the panel's own type.
    await expect(panel.getByRole("heading", { name: "Waiting for payment" })).toBeVisible();
    await expect(panel.getByRole("listitem").filter({ hasText: "#1008" })).toBeVisible();
    await expect(panel.locator("strong", { hasText: "₹2,952" })).toBeVisible();
    // Raw HTML in a reply is dropped, never run.
    expect(await panel.locator('img[src="x"]').count(), "no image from a reply").toBe(0);
    expect(
      await page.evaluate(() => (window as { __hit?: number }).__hit),
      "nothing a reply wrote ran"
    ).toBeUndefined();
    // Tapped, a follow-up is sent as it was written.
    const sent = catchNextTurn(page);
    await panel.getByRole("button", { name: /^Ask: Remind me every morning/ }).click();
    expect(await sent).toBe("Remind me every morning about COD orders that are still unpaid");
  } finally {
    await shop.admin.from("conversations").delete().eq("id", thread);
  }
});

test("questions are asked the way their answers depend on each other", async ({ signedIn: page, shop }) => {
  // Three that build on each other are asked one at a time; each says
  // whether one answer or several fit, and the answers go back as one.
  const thread = await replyThread(shop, {
    type: "clarify",
    message: "A few things so the alerts fit how you restock:",
    questions: [
      { id: "when", question: "When do you want to hear?", suggestions: ["As it happens", "Every morning"] },
      { id: "what", question: "What counts as low?", suggestions: ["Under 5 left", "Under 10 left"] },
      { id: "which", question: "Which products?", suggestions: ["Best sellers", "New arrivals"], multi: true },
    ],
  });
  try {
    await page.goto(`/app/${shop.projectId}`);
    const { panel } = await luke(page);
    await expect(panel.getByText("1 of 3")).toBeVisible();
    await expect(panel.getByText("What counts as low?")).toHaveCount(0);
    await panel.getByRole("radio", { name: "Every morning" }).click();
    await panel.getByRole("button", { name: "Next" }).click();
    // One answer to this one: a second pick replaces the first.
    await panel.getByRole("radio", { name: "Under 5 left" }).click();
    await panel.getByRole("radio", { name: "Under 10 left" }).click();
    await expect(panel.getByRole("radio", { name: "Under 5 left" })).toHaveAttribute("aria-checked", "false");
    await panel.getByRole("button", { name: "Next" }).click();
    // Several to this one.
    await panel.getByRole("checkbox", { name: "Best sellers" }).click();
    await panel.getByRole("checkbox", { name: "New arrivals" }).click();
    const sent = catchNextTurn(page);
    await panel.getByRole("button", { name: "Send answers" }).click();
    const composed = await sent;
    expect(composed).toContain("When do you want to hear?\n→ Every morning");
    expect(composed).toContain("What counts as low?\n→ Under 10 left");
    expect(composed).toContain("Which products?\n→ Best sellers, New arrivals");
  } finally {
    await shop.admin.from("conversations").delete().eq("id", thread);
  }
});

test("two questions that do not lean on each other are asked together", async ({ signedIn: page, shop }) => {
  const thread = await replyThread(shop, {
    type: "clarify",
    message: "Two quick details:",
    together: true,
    questions: [
      { id: "name", question: "What should the section be called?", suggestions: ["Suppliers", "Vendors"] },
      { id: "keep", question: "What do you keep for each?", suggestions: ["Phone", "Email"], multi: true },
    ],
  });
  try {
    await page.goto(`/app/${shop.projectId}`);
    const { panel } = await luke(page);
    await expect(panel.getByText("What should the section be called?")).toBeVisible();
    await expect(panel.getByText("What do you keep for each?")).toBeVisible();
    await expect(panel.getByText("1 of 2")).toHaveCount(0);
  } finally {
    await shop.admin.from("conversations").delete().eq("id", thread);
  }
});

test("a part of a design that is optional can be left out before building", async ({ signedIn: page, shop }) => {
  const thread = await designThread(shop, [
    newSection("e2e-kept", "Kept"),
    { ...newSection("e2e-maybe", "Maybe"), optional: true, optionalWhy: "Handy once there are many." },
  ]);
  try {
    await page.goto(`/app/${shop.projectId}`);
    const { panel } = await luke(page);
    // Each part by its own name, and what kind of thing it is.
    await expect(panel.getByText("Optional · New section · 1 field")).toBeVisible();
    const include = panel.getByRole("checkbox", { name: "Include Maybe" });
    await expect(include).toHaveAttribute("aria-checked", "true");
    await expect(panel.getByRole("button", { name: "Build these 2" })).toBeVisible();
    await include.click();
    await expect(include).toHaveAttribute("aria-checked", "false");
    await expect(panel.getByRole("button", { name: "Build this" })).toBeVisible();
  } finally {
    await shop.admin.from("conversations").delete().eq("id", thread);
  }
});

test("past conversations are grouped by day, found by name, and say what each holds", async ({
  signedIn: page,
  shop,
}) => {
  const H = 3_600_000;
  const now = Date.now();
  const made: string[] = [];
  const thread = async (title: string, ago: number, payloads: Record<string, unknown>[] = []) => {
    const { data } = await shop.admin
      .from("conversations")
      .insert({ project_id: shop.projectId, title })
      .select("id")
      .single();
    if (payloads.length) {
      await shop.admin.from("messages").insert(
        payloads.map((payload, i) => ({
          conversation_id: data!.id,
          role: "assistant",
          content: "",
          payload,
          created_at: new Date(now - ago - 60_000 + i).toISOString(),
        }))
      );
    }
    // After the messages, which move a conversation to the top when they arrive.
    await shop.admin
      .from("conversations")
      .update({ updated_at: new Date(now - ago).toISOString() })
      .eq("id", data!.id);
    made.push(data!.id as string);
  };
  try {
    await thread("Unpaid COD orders", 60_000, [
      { type: "answer", kind: "store", message: "Two." },
      { type: "build", status: "built", message: "Built 2 changes", sent: [0, 1] },
    ]);
    await thread("Top buyer this month", 26 * H);
    await thread("Returns desk", 3 * 24 * H);
    await thread("Stock alerts", 4 * 24 * H);
    await thread("Supplier list", 10 * 24 * H);
    await thread("Greeting", 12 * 24 * H);
    await page.goto(`/app/${shop.projectId}`);
    const { panel } = await luke(page);
    await panel.getByRole("button", { name: "Past conversations" }).click();
    const today = panel.getByRole("group", { name: "Today" });
    await expect(today.getByText("Unpaid COD orders")).toBeVisible();
    await expect(today.getByText("1 built · 1 answer")).toBeVisible();
    await expect(panel.getByRole("group", { name: "Yesterday" }).getByText("Top buyer this month")).toBeVisible();
    await expect(panel.getByRole("group", { name: "Older" }).getByText("Greeting")).toBeVisible();
    // More than a screenful, so they can be found by name.
    await panel.getByRole("searchbox", { name: "Search conversations" }).fill("stock");
    await expect(panel.getByText("Stock alerts")).toBeVisible();
    await expect(panel.getByText("Returns desk")).toHaveCount(0);
  } finally {
    for (const id of made) await shop.admin.from("conversations").delete().eq("id", id);
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
