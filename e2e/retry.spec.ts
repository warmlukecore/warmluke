// A turn Luke could not finish is tried again by one click (lib/errors
// retryFix, 16 Oct): the same words sent again, never retyped, with
// none offered where a second try cannot help; and a turn that failed
// before a reload still offers it. At both widths. No model is asked:
// the chat route's answers are stubbed.
import type { Page } from "@playwright/test";
import { LUKE_COPY } from "@/lib/luke-copy";
import { expect, test } from "./shop";

async function luke(page: Page) {
  await expect(page.getByRole("img", { name: /Orders per day/ })).toBeVisible({ timeout: 30_000 });
  const panel = page.getByRole("complementary", { name: "Luke" });
  const box = panel.getByPlaceholder(LUKE_COPY.placeholder);
  if ((page.viewportSize()?.width ?? 0) < 1024) await page.getByRole("button", { name: /^Luke/ }).first().click();
  await expect(box).toBeInViewport();
  await expect(panel.getByRole("status", { name: "Opening your conversation" })).toHaveCount(0);
  return { panel, box };
}

const BUSY = "Luke's model is busy right now. Nothing was changed — try again in a minute.";
const BILLING = "Luke is paused: its model account needs topping up on our side. Nothing was changed.";

test("Try again sends the same words once more, and is not offered where it cannot help", async ({
  signedIn: page,
  shop,
}) => {
  const sent: string[] = [];
  await page.route("**/api/chat", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    sent.push(String((route.request().postDataJSON() as { message?: string }).message));
    return route.fulfill({
      json: sent.length === 1 ? { error: BUSY, failed: "busy" } : { error: BILLING, failed: "billing" },
    });
  });
  await page.goto(`/app/${shop.projectId}`);
  const { panel, box } = await luke(page);
  await box.fill("Show me this week's unpaid orders");
  await box.press("Enter");
  await expect(panel.getByText(BUSY)).toBeVisible();
  const again = panel.getByRole("button", { name: "Try again" });
  await expect(again).toHaveCount(1);
  await panel.screenshot({ path: `${process.env.LOOK_DIR ?? "test-results"}/retry-${test.info().project.name}.png` });
  await again.click();
  await expect(panel.getByText(BILLING)).toBeVisible();
  expect(sent).toEqual(["Show me this week's unpaid orders", "Show me this week's unpaid orders"]);
  // The account needs topping up: one more click would only say so again.
  await expect(panel.getByRole("button", { name: "Try again" })).toHaveCount(1);
  void shop;
});

test("a turn that did not finish before a reload still offers Try again", async ({ signedIn: page, shop }) => {
  const { data: thread } = await shop.admin
    .from("conversations")
    .insert({ project_id: shop.projectId, title: "Returns tool" })
    .select("id")
    .single();
  try {
    const at = Date.now();
    await shop.admin.from("messages").insert([
      {
        conversation_id: thread!.id,
        role: "user",
        content: "Make a returns tool",
        payload: { text: "Make a returns tool" },
        created_at: new Date(at - 2_000).toISOString(),
      },
      {
        conversation_id: thread!.id,
        role: "assistant",
        content: "",
        payload: {
          type: "unanswered",
          message:
            "Luke couldn't finish this one: it kept failing its own checks, so nothing was changed. Try again sends it once more, with what went wrong; there is nothing to retype.",
        },
        created_at: new Date(at - 1_000).toISOString(),
      },
    ]);
    await shop.admin
      .from("conversations")
      .update({ updated_at: new Date(at).toISOString() })
      .eq("id", thread!.id);
    const sent: string[] = [];
    await page.route("**/api/chat", (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      sent.push(String((route.request().postDataJSON() as { message?: string }).message));
      return route.fulfill({ json: { error: BUSY, failed: "busy" } });
    });
    await page.goto(`/app/${shop.projectId}`);
    const { panel } = await luke(page);
    await expect(panel.getByText("Luke couldn't finish this one")).toBeVisible();
    await panel.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => sent).toEqual(["Make a returns tool"]);
  } finally {
    await shop.admin.from("conversations").delete().eq("id", thread!.id);
  }
});
