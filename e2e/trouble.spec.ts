// The radar on the console (0211): yesterday's card on the first screen
// names the conversation that went worst, Needs a look lists its signs,
// and a sign opens the very turn it is about. Walked at both widths with
// a conversation planted as Tanish's went: three builds in an hour, an
// owner asking "why would I lie", Luke saying he can't.
import { readFileSync } from "node:fs";
import { expect, test } from "./shop";

/** An env file's ADMIN_PATH, or nothing. */
function adminPathIn(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8")
      .match(/^ADMIN_PATH=(.*)$/m)?.[1]
      ?.trim();
  } catch {
    return undefined;
  }
}

/** The console's address, found as the server finds it (lib/console-path): its env, then .env.local, else "admin". */
function consoleAt(): string {
  const set = process.env.ADMIN_PATH ?? adminPathIn(process.env.ENV_FILE ?? ".env.local") ?? adminPathIn(".env.local");
  return set && /^[A-Za-z0-9_-]{6,64}$/.test(set) ? set : "admin";
}

test("yesterday's worst conversation is on the console, and a sign opens its turn", async ({
  signedIn: page,
  shop,
}) => {
  const tag = Date.now().toString(36);
  // Noon yesterday, in India: the browser's zone on this machine and the card's default.
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const noon = new Date(`${today}T12:00:00+05:30`).getTime() - 86_400_000;
  const at = (m: number) => new Date(noon + m * 60_000).toISOString();
  const { data: convo, error: made } = await shop.admin
    .from("conversations")
    .insert({ project_id: shop.projectId, title: `Parent stock ${tag}` })
    .select("id")
    .single();
  expect(made).toBeNull();
  const cant = crypto.randomUUID();
  const { error: said } = await shop.admin.from("messages").insert([
    {
      id: crypto.randomUUID(),
      conversation_id: convo!.id,
      role: "assistant",
      content: "",
      payload: { type: "build", message: "New section" },
      created_at: at(0),
    },
    {
      id: crypto.randomUUID(),
      conversation_id: convo!.id,
      role: "assistant",
      content: "",
      payload: { type: "build", message: "Change it" },
      created_at: at(20),
    },
    {
      id: crypto.randomUUID(),
      conversation_id: convo!.id,
      role: "assistant",
      content: "",
      payload: { type: "build", message: "Again" },
      created_at: at(40),
    },
    {
      id: crypto.randomUUID(),
      conversation_id: convo!.id,
      role: "user",
      content: "x",
      payload: { kind: "user", text: "bro, why would I lie?" },
      created_at: at(45),
    },
    {
      id: cant,
      conversation_id: convo!.id,
      role: "assistant",
      content: "",
      payload: { type: "answer", message: "I can't actually see your custom rows. Check Parent Stock." },
      created_at: at(46),
    },
  ]);
  expect(said).toBeNull();
  // The check user is the check project's standing administrator (seed-check-project):
  // what it was before is what it goes back to, or every console check after this one fails.
  const { data: before } = await shop.admin
    .from("account_settings")
    .select("is_superadmin")
    .eq("user_id", shop.userId)
    .maybeSingle();
  const { error: raised } = await shop.admin
    .from("account_settings")
    .upsert({ user_id: shop.userId, is_superadmin: true });
  expect(raised).toBeNull();
  // From the start, as a fresh database: what was planted back in time is scanned.
  const { error: reset } = await shop.admin.from("trouble_scan").delete().eq("one", true);
  expect(reset).toBeNull();
  const scoped = `?account=${shop.userId}`;
  try {
    await page.goto(`/${consoleAt()}${scoped}`);
    // One account in view opens its detail over the list: closed, as an administrator would.
    const detail = page.getByRole("dialog");
    if (
      await detail.waitFor({ timeout: 10_000 }).then(
        () => true,
        () => false
      )
    ) {
      await page.keyboard.press("Escape");
      await expect(detail).toBeHidden();
    }
    const card = page.getByRole("region", { name: "Yesterday" });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText(/things went wrong yesterday/)).toBeVisible();
    await expect(card.getByText(`Parent stock ${tag}`)).toBeVisible();
    await expect(card.getByText(/Rebuilds/).first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({
      path: `${process.env.LOOK_DIR ?? "test-results"}/trouble-day-${test.info().project.name}.png`,
      fullPage: false,
    });

    await card.getByRole("link", { name: "See all in Needs a look" }).click();
    await expect(page.getByRole("heading", { name: "Needs a look" })).toBeVisible({ timeout: 30_000 });
    const sign = page.getByRole("listitem").filter({ hasText: "Luke says he can't" }).filter({ hasText: tag });
    await expect(sign).toBeVisible();
    await expect(sign).toContainText("I can't actually see your custom rows");
    await page.getByRole("radio", { name: "Worst first" }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({
      path: `${process.env.LOOK_DIR ?? "test-results"}/trouble-list-${test.info().project.name}.png`,
    });

    await sign.getByRole("link", { name: "Open the turn" }).click();
    await expect(page).toHaveURL(new RegExp(`#turn-${cant}$`));
    const turn = page.locator(`[id="turn-${cant}"]`);
    await expect(turn).toBeVisible({ timeout: 30_000 });
    await expect(turn).toContainText("I can't actually see your custom rows");
    await expect(turn).toBeInViewport();
  } finally {
    await shop.admin
      .from("account_settings")
      .update({ is_superadmin: before?.is_superadmin === true })
      .eq("user_id", shop.userId);
    await shop.admin.from("conversations").delete().eq("id", convo!.id);
  }
});
