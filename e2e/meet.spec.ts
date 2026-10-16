// Luke meets them first (0200, 9 Oct): a new owner's app opens on Luke,
// full screen, before anything else. He speaks first and nothing of the
// app is there; once he has helped he asks whether to open their store,
// and their yes ("open_store" on his answer) lets them in, Luke beside it.
// "Go to store" at the top is their own way in at any moment (14 Oct).
// His replies are stood in here: what is checked is the screen, not his
// words.
import type { Page } from "@playwright/test";
import { expect, test, type Shop } from "./shop";

const THREAD = "00000000-0000-4000-8000-00000000c0de";

/**
 * An owner just through onboarding, not yet let into the store, with an
 * older thread their own AI started, and Luke's replies stood in. Returns
 * what each turn asked and how to put the account back.
 */
async function meeting(page: Page, shop: Shop) {
  // Just through onboarding, not yet let into the store; put back as it was after.
  const { data: had } = await shop.admin.from("profiles").select("*").eq("user_id", shop.userId).maybeSingle();
  const made = await shop.admin.from("profiles").upsert({
    user_id: shop.userId,
    full_name: "Asha Rao",
    business_name: "Asha Crafts",
    role: "founder",
    monthly_orders: "under_500",
    platform: "shopify",
    website: "ashacrafts.example",
    onboarded_at: new Date().toISOString(),
  });
  expect(made.error).toBeNull();
  // The server alone may ask again (0200): cleared by the service role.
  await shop.admin.from("profiles").update({ met_luke_at: null }).eq("user_id", shop.userId);

  // An older thread already there, as one their own AI started before they
  // opened the app: it must not be opened over his hello (9 Oct).
  const { data: older } = await shop.admin
    .from("conversations")
    .insert({ project_id: shop.projectId, title: "Asked by their AI", created_by: shop.userId })
    .select("id")
    .single();
  await shop.admin.from("messages").insert({
    conversation_id: older!.id,
    role: "user",
    content: "List my unpaid orders",
    payload: { kind: "user", text: "List my unpaid orders" },
  });

  const asked: Array<Record<string, unknown>> = [];
  await page.route("**/api/chat", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    asked.push(route.request().postDataJSON() as Record<string, unknown>);
    // His first words take a moment, as they do: long enough to be seen waiting.
    if (asked.length === 1) await new Promise((r) => setTimeout(r, 1500));
    const reply =
      asked.length === 1
        ? {
            type: "clarify",
            message: "Hi, I'm Luke. I've already read your store: **10 orders** this month, **2** paid on delivery.",
            questions: [
              {
                id: "q1",
                question: "What takes most of your time?",
                suggestions: ["Calling COD customers", "Packing and shipping"],
              },
            ],
          }
        : asked.length === 2
          ? {
              type: "answer",
              kind: "store",
              message:
                "That fits what I see: **2** of your 10 orders are cash on delivery and still unpaid. Want to see your store now?",
            }
          : { type: "answer", kind: "conversation", message: "Here it is.", open_store: true };
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
      body:
        [
          { step: "accepted", conversationId: THREAD, turn: null },
          { reply, conversationId: THREAD },
        ]
          .map((l) => JSON.stringify(l))
          .join("\n") + "\n",
    });
  });

  const putBack = async () => {
    await shop.admin.from("conversations").delete().eq("id", older!.id);
    if (had) await shop.admin.from("profiles").upsert(had);
    else await shop.admin.from("profiles").delete().eq("user_id", shop.userId);
  };
  return { asked, putBack, older: older!.id };
}

/** In the store: the Overview's greeting, as luke.spec waits for it on a busy check database. */
const inTheStore = (page: Page) =>
  expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening), Asha/ })).toBeVisible({
    timeout: 30_000,
  });

const metLuke = (shop: Shop) =>
  expect
    .poll(
      async () =>
        (await shop.admin.from("profiles").select("met_luke_at").eq("user_id", shop.userId).single()).data?.met_luke_at
    )
    .not.toBeNull();

test("the first conversation is Luke's alone, and the store opens on their yes to his offer", async ({
  signedIn: page,
  shop,
}) => {
  const { asked, putBack, older } = await meeting(page, shop);
  // The meeting's own look for a thread of his, held a moment: the window
  // in which a live echo of another thread opened it over him (CI, 14 Oct).
  await page.route(/\/rest\/v1\/messages\?.*kind=eq\.meet/, async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  try {
    await page.goto(`/app/${shop.projectId}`);
    const luke = page.getByRole("complementary", { name: "Luke" });
    // They may type before he has spoken (16 Oct), but nothing is sent until he has:
    // sent, it raced his hello into a second thread.
    const early = page.getByPlaceholder("Luke is saying hello… you can start typing");
    await expect(early).toBeEditable({ timeout: 30_000 });
    await early.fill("hi");
    await expect(luke.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await early.press("Enter");
    await early.fill("");
    // Their AI writes in its own thread while he is about to say hello: its
    // live echo opened that thread over him, and he never spoke (CI, 14 Oct).
    // A second for the page's live channel to be joined, inside the hold above.
    await page.waitForTimeout(1000);
    await shop.admin.from("messages").insert({
      conversation_id: older,
      role: "user",
      content: "And the refunds?",
      payload: { kind: "user", text: "And the refunds?" },
    });
    await shop.admin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", older);
    await expect(luke.getByText("I've already read your store")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByPlaceholder("Reply to Luke, in your own words")).toBeEnabled();
    await expect(luke.getByText("List my unpaid orders")).toHaveCount(0);
    await expect(luke.getByText("And the refunds?")).toHaveCount(0);
    // He spoke first: no words of theirs, the meeting's flag on it.
    expect(asked[0]).toMatchObject({ meet: true, message: "" });
    // Nothing of the app and none of the panel's controls: Luke, and their own way into the store.
    await expect(page.getByRole("link", { name: "Overview" })).toBeHidden();
    for (const name of [/History/, /New conversation/, "Close Luke", "Hide Luke's panel", /Luke full width/])
      await expect(luke.getByRole("button", { name })).toHaveCount(0);
    await expect(luke.getByRole("button", { name: "Go to store" })).toBeVisible();

    // Having helped, he asks in words whether to open their store, and
    // nothing of the app shows until they say yes or go in themselves.
    await luke.getByText("Calling COD customers").click();
    await luke.getByRole("button", { name: /Send answer/ }).click();
    await expect(luke.getByText("Want to see your store now?")).toBeVisible();
    expect(asked[1]).toMatchObject({ meet: true });
    await expect(page.getByRole("link", { name: "Overview" })).toBeHidden();
    await expect(page.getByRole("button", { name: /Open my store/ })).toHaveCount(0);

    // Their yes, his "open_store": in, Luke beside the store, and never asked again.
    await page.getByPlaceholder("Reply to Luke, in your own words").fill("haan dikhao");
    await page.keyboard.press("Enter");
    await inTheStore(page);
    await metLuke(shop);
    await page.reload();
    await inTheStore(page);
    await expect(page.getByRole("status", { name: "Luke is reading your store" })).toHaveCount(0);
  } finally {
    await putBack();
  }
});

test("Go to store lets them in at any moment, and the meeting is not asked again", async ({ signedIn: page, shop }) => {
  const { putBack } = await meeting(page, shop);
  try {
    await page.goto(`/app/${shop.projectId}`);
    const luke = page.getByRole("complementary", { name: "Luke" });
    await expect(luke.getByText("I've already read your store")).toBeVisible({ timeout: 30_000 });
    await page.screenshot({
      path: `${process.env.LOOK_DIR ?? "test-results"}/meet-go-to-store-${test.info().project.name}.png`,
    });
    // Before answering anything: their choice, not his.
    await luke.getByRole("button", { name: "Go to store" }).click();
    await inTheStore(page);
    await expect(luke.getByRole("button", { name: "Go to store" })).toHaveCount(0);
    await metLuke(shop);
    await page.reload();
    await inTheStore(page);
  } finally {
    await putBack();
  }
});
