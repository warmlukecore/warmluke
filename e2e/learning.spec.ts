// Luke learning per merchant (0176), as the owner sees it: what Luke
// learned, listed under the composer and theirs to strike; and the thumbs
// under a reply, kept with a line of why, read back as the thread opens,
// and taken back by a second tap. Seeded as the reflector and the chat
// route would have kept them, so no model is asked.
import type { Page } from "@playwright/test";
import { LUKE_COPY } from "@/lib/luke-copy";
import { expect, test } from "./shop";

/** Luke's panel, opened once the page has its figures: a drawer below the wide layout (lg, 1024px). */
async function luke(page: Page) {
  await expect(page.getByRole("img", { name: /Orders per day/ })).toBeVisible({ timeout: 30_000 });
  const panel = page.getByRole("complementary", { name: "Luke" });
  if ((page.viewportSize()?.width ?? 0) < 1024) await page.getByRole("button", { name: /^Luke/ }).first().click();
  await expect(panel.getByPlaceholder(LUKE_COPY.placeholder)).toBeInViewport();
  await expect(panel.getByRole("status", { name: "Opening your conversation" })).toHaveCount(0);
  return panel;
}

test("what Luke learned is listed, folds open, and is struck by the owner", async ({ signedIn: page, shop }) => {
  const title = "Name the courier before the AWB";
  const body = "Say Delhivery or Bluedart first, then the AWB, the way the packers read the slip.";
  const { data: skill, error } = await shop.admin
    .from("luke_skills")
    .insert({
      project_id: shop.projectId,
      kind: "lesson",
      title,
      when_to_use: "When a question is about a shipment",
      body,
      status: "active",
      uses: 3,
      created_by: "reflector",
    })
    .select("id")
    .single();
  expect(error, "the lesson was kept").toBeNull();
  const id = skill!.id as string;
  try {
    await page.goto(`/app/${shop.projectId}`);
    const panel = await luke(page);
    // Folded by default, beside what Luke knows; opened, it lists it, new since never looked.
    await panel.getByText("What Luke learned").click();
    const item = panel.getByRole("listitem").filter({ hasText: title });
    await expect(item).toBeVisible();
    await expect(item.getByText("Lesson", { exact: true })).toBeVisible();
    await expect(item.getByText("When a question is about a shipment")).toBeVisible();
    await expect(item.getByText("Used 3 times")).toBeVisible();
    await expect(item.getByRole("img", { name: "New" })).toBeVisible();

    // The body folds behind Show and Hide.
    await expect(item.getByText(body)).toHaveCount(0);
    await item.getByRole("button", { name: "Show", exact: true }).click();
    await expect(item.getByText(body)).toBeVisible();
    await item.getByRole("button", { name: "Hide", exact: true }).click();
    await expect(item.getByText(body)).toHaveCount(0);

    // Struck: gone from the list, kept as struck, and the strike written down.
    await item.getByRole("button", { name: `Forget: ${title}` }).click();
    await expect(panel.getByText(title)).toHaveCount(0);
    await expect
      .poll(async () => (await shop.admin.from("luke_skills").select("status").eq("id", id).single()).data?.status)
      .toBe("struck");
    await expect
      .poll(async () => (await shop.admin.from("luke_learning_events").select("event, detail").eq("skill_id", id)).data)
      .toEqual([{ event: "struck", detail: { by: "owner" } }]);
  } finally {
    await shop.admin.from("luke_learning_events").delete().eq("skill_id", id);
    await shop.admin.from("luke_skills").delete().eq("id", id);
  }
});

test("a reply is rated not helpful with a line of why, read back, and taken back", async ({ signedIn: page, shop }) => {
  const answer = { type: "answer", message: "Twelve orders came in today." };
  // The newest thread, so it is the one the panel opens.
  const { data: thread } = await shop.admin
    .from("conversations")
    .insert({
      project_id: shop.projectId,
      title: "e2e feedback",
      updated_at: new Date(Date.now() + 60_000).toISOString(),
    })
    .select("id")
    .single();
  const { data: kept, error } = await shop.admin
    .from("messages")
    .insert([
      {
        conversation_id: thread!.id,
        role: "user",
        content: "How many orders came in today?",
        payload: null,
        created_at: new Date().toISOString(),
      },
      {
        conversation_id: thread!.id,
        role: "assistant",
        content: JSON.stringify(answer),
        payload: answer,
        created_at: new Date(Date.now() + 1000).toISOString(),
      },
    ])
    .select("id, role");
  expect(error, "the exchange went into the thread").toBeNull();
  const answerId = kept!.find((m) => m.role === "assistant")!.id as string;
  const rows = async () =>
    (await shop.admin.from("reply_feedback").select("verdict, note").eq("message_id", answerId)).data;
  try {
    await page.goto(`/app/${shop.projectId}`);
    let panel = await luke(page);
    await expect(panel.getByText(answer.message)).toBeVisible();

    // Kept on the tap; the line of why is optional, and Enter sends it.
    const down = panel.getByRole("button", { name: "Not helpful" });
    await down.click();
    await expect(down).toHaveAttribute("aria-pressed", "true");
    const why = panel.getByPlaceholder("What was wrong? (optional)");
    await why.fill("It counted yesterday's orders too");
    await why.press("Enter");
    await expect(why).toHaveCount(0);
    await expect.poll(rows).toEqual([{ verdict: "down", note: "It counted yesterday's orders too" }]);

    // Read back as the thread opens again, and taken back by the same thumb.
    await page.reload();
    panel = await luke(page);
    const again = panel.getByRole("button", { name: "Not helpful" });
    await expect(again).toHaveAttribute("aria-pressed", "true");
    await again.click();
    await expect(again).toHaveAttribute("aria-pressed", "false");
    await expect(panel.getByPlaceholder("What was wrong? (optional)")).toHaveCount(0);
    await expect.poll(rows).toEqual([]);
  } finally {
    await shop.admin.from("reply_feedback").delete().eq("message_id", answerId);
    await shop.admin.from("conversations").delete().eq("id", thread!.id);
  }
});
