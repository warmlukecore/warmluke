// Did it work? (0190), on the owner's screen: a build of theirs nobody has
// used since, three days on, waits in the bell under what waits on them,
// named by its section; "It's fine" keeps the answer and the card goes.
// The build is made as Luke's would be: a section and its build message,
// dated back (the database side, who may see and answer it and how the
// judge reads it, is check-follow-up-live).
import { expect, test } from "./shop";

test("a build nobody used is asked about once in the bell, and the answer is kept", async ({
  signedIn: page,
  shop,
}) => {
  const { data: mod } = await shop.admin
    .from("modules")
    .insert({
      project_id: shop.projectId,
      name: "e2e-followup-shelf",
      nav_label: "Shelf checks",
      icon: "table",
      route: "/e2e-followup-shelf",
      sort_order: 90,
    })
    .select("id")
    .single();
  // Just past three days: the newest a question can be, so it is the one shown.
  const built = new Date(Date.now() - 3 * 86400000 - 3600000).toISOString();
  const { data: convo } = await shop.admin
    .from("conversations")
    .insert({ project_id: shop.projectId, title: "Shelf checks", created_by: shop.userId })
    .select("id")
    .single();
  const { data: build } = await shop.admin
    .from("messages")
    .insert({
      conversation_id: convo!.id,
      role: "assistant",
      content: "",
      payload: { type: "build", status: "built", made: [mod!.id], finished_at: built },
      created_at: built,
    })
    .select("id")
    .single();
  try {
    await page.goto(`/app/${shop.projectId}`);
    const phone = (page.viewportSize()?.width ?? 0) < 1024;
    if (phone) await page.getByRole("button", { name: /^Luke/ }).first().click();
    const panel = page.getByRole("complementary", { name: "Luke" });
    const bell = panel.getByRole("button", { name: /want your attention/ });
    await expect(bell).toBeVisible({ timeout: 30_000 });
    await bell.click();
    await expect(panel.getByText("DID IT WORK?")).toBeVisible();
    await expect(panel.getByText(/“Shelf checks”, built .* has not been used since\./)).toBeVisible();
    await expect(panel.getByRole("button", { name: "Not what I meant" })).toBeVisible();
    await panel.getByRole("button", { name: "It’s fine" }).click();
    await expect(panel.getByText("DID IT WORK?")).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await shop.admin.from("build_followups").select("answer").eq("build_id", build!.id).maybeSingle()).data
            ?.answer
      )
      .toBe("fine");
  } finally {
    await shop.admin.from("conversations").delete().eq("id", convo!.id);
    await shop.admin.from("modules").delete().eq("id", mod!.id);
  }
});
