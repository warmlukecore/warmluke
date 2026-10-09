// Luke meets them first (0200, 9 Oct): a new owner's app opens on Luke,
// full screen, before anything else. He speaks first, nothing of the app
// is there and there is no way past him until he has helped; once he has,
// the store is theirs to open and he moves aside, beside it. His replies
// are stood in here: what is checked is the screen, not his words.
import { expect, test } from "./shop";

const THREAD = "00000000-0000-4000-8000-00000000c0de";

test("the first conversation is Luke's alone, and the store opens only once he has helped", async ({
  signedIn: page,
  shop,
}) => {
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
        : {
            type: "answer",
            kind: "store",
            message: "That fits what I see: **2** of your 10 orders are cash on delivery and still unpaid.",
          };
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

  try {
    await page.goto(`/app/${shop.projectId}`);
    const luke = page.getByRole("complementary", { name: "Luke" });
    // Nothing to type into before he has spoken: typed into, it raced his hello into a second thread.
    await expect(page.getByPlaceholder("Luke is saying hello…")).toBeDisabled({ timeout: 30_000 });
    await expect(luke.getByText("I've already read your store")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByPlaceholder("Reply to Luke, in your own words")).toBeEnabled();
    await expect(luke.getByText("List my unpaid orders")).toHaveCount(0);
    // He spoke first: no words of theirs, the meeting's flag on it.
    expect(asked[0]).toMatchObject({ meet: true, message: "" });
    // Nothing of the app, and no way past him yet.
    await expect(page.getByRole("link", { name: "Overview" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Open my store" })).toHaveCount(0);
    for (const name of [/History/, /New conversation/, "Close Luke", "Hide Luke's panel", /Luke full width/])
      await expect(luke.getByRole("button", { name })).toHaveCount(0);

    // His hello read from the store is not help; an answer from it, to their own question, is.
    await luke.getByText("Calling COD customers").click();
    await luke.getByRole("button", { name: /Send answer/ }).click();
    await expect(luke.getByText("That fits what I see")).toBeVisible();
    expect(asked[1]).toMatchObject({ meet: true });
    const open = page.getByRole("button", { name: "Open my store" });
    await expect(open).toBeVisible();

    // In: Luke beside the store, and never asked again.
    await open.click();
    await expect(open).toHaveCount(0);
    // The Overview's counts, as luke.spec waits for them on a busy check database.
    await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening), Asha/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(
        async () =>
          (await shop.admin.from("profiles").select("met_luke_at").eq("user_id", shop.userId).single()).data
            ?.met_luke_at
      )
      .not.toBeNull();
    await page.reload();
    // The Overview's counts, as luke.spec waits for them on a busy check database.
    await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening), Asha/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("status", { name: "Luke is reading your store" })).toHaveCount(0);
  } finally {
    await shop.admin.from("conversations").delete().eq("id", older!.id);
    if (had) await shop.admin.from("profiles").upsert(had);
    else await shop.admin.from("profiles").delete().eq("user_id", shop.userId);
  }
});
