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
  // The new thread joins the switcher, and the trace survives it: it used
  // to be rebuilt from the saved rows, which carry none.
  await expect(panel.getByRole("button", { name: "Past conversations" })).toContainText("1");
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
