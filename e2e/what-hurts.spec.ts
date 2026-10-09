// What hurts them (0201), on the owner's screen: the problems they named
// listed with how what was built for each went, set aside by them, a fact
// told to Luke kept; and a week after a fix, the bell asks whether it
// helped, once. The database side (who may see and answer, the week, the
// cap) is check-memory's.
import { expect, test } from "./shop";

test("what hurts them is listed and theirs to set aside, and a week after its fix the bell asks if it helped", async ({
  signedIn: page,
  shop,
}) => {
  const { data: mod } = await shop.admin
    .from("modules")
    .insert({
      project_id: shop.projectId,
      name: "e2e-cod-calls",
      nav_label: "COD calls",
      icon: "table",
      route: "/e2e-cod-calls",
      sort_order: 91,
    })
    .select("id")
    .single();
  const { data: convo } = await shop.admin
    .from("conversations")
    .insert({ project_id: shop.projectId, title: "COD calls", created_by: shop.userId })
    .select("id")
    .single();
  // Said nine days ago, and something built for it eight days ago, in the same conversation.
  const { data: hurt } = await shop.admin
    .from("merchant_problems")
    .insert({
      project_id: shop.projectId,
      conversation_id: convo!.id,
      problem: "COD calls eat the morning",
      cost: "two hours a day",
      created_at: new Date(Date.now() - 9 * 86400000).toISOString(),
    })
    .select("id")
    .single();
  await shop.admin.from("merchant_problems").insert({ project_id: shop.projectId, problem: "Wrong sizes go out" });
  const built = new Date(Date.now() - 8 * 86400000).toISOString();
  await shop.admin.from("messages").insert({
    conversation_id: convo!.id,
    role: "assistant",
    content: "",
    payload: { type: "build", status: "built", made: [mod!.id], finished_at: built },
    created_at: built,
  });

  try {
    await page.goto(`/app/${shop.projectId}`);
    // Ready once the shop's figures are in, as luke.spec opens the panel; a drawer on a phone.
    await expect(page.getByRole("img", { name: /Orders per day/ })).toBeVisible({ timeout: 30_000 });
    const panel = page.getByRole("complementary", { name: "Luke" });
    if ((page.viewportSize()?.width ?? 0) < 1024) await page.getByRole("button", { name: /^Luke/ }).first().click();
    await expect(panel.getByRole("button", { name: /want your attention/ })).toBeInViewport();

    // The bell: did it help? Once, and the answer is kept.
    await panel.getByRole("button", { name: /want your attention/ }).click();
    const card = panel.getByText("DID IT HELP?").locator("..");
    await expect(card).toContainText("COD calls eat the morning");
    await expect(card).toContainText("“COD calls” was built for it");
    await card.getByRole("button", { name: "Better" }).click();
    await expect(panel.getByText("DID IT HELP?")).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await shop.admin.from("merchant_problems").select("status").eq("id", hurt!.id).single()).data?.status
      )
      .toBe("better");
    await page.keyboard.press("Escape");

    // What Luke knows: the problems with how they went, theirs to set aside; a fact told kept.
    await panel.getByText("What Luke knows about you").click();
    await expect(panel.getByText("What’s hard for you")).toBeVisible();
    await expect(panel.getByText(/COD calls eat the morning/)).toContainText("Better now");
    await panel.getByRole("button", { name: "Set aside: Wrong sizes go out" }).click();
    await expect(panel.getByText("Wrong sizes go out")).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (
            await shop.admin
              .from("merchant_problems")
              .select("status")
              .eq("project_id", shop.projectId)
              .eq("problem", "Wrong sizes go out")
              .single()
          ).data?.status
      )
      .toBe("dropped");
    const tell = panel.getByRole("textbox", { name: "Tell Luke something about your business" });
    await tell.fill("Two of us pack, after 6pm");
    await panel.getByRole("button", { name: "Keep" }).click();
    await expect(panel.getByText("Two of us pack, after 6pm")).toBeVisible();
    await expect
      .poll(
        async () =>
          (
            await shop.admin
              .from("merchant_notes")
              .select("note")
              .eq("project_id", shop.projectId)
              .eq("note", "Two of us pack, after 6pm")
          ).data?.length
      )
      .toBe(1);
  } finally {
    await shop.admin.from("merchant_problems").delete().eq("project_id", shop.projectId);
    await shop.admin.from("merchant_notes").delete().eq("project_id", shop.projectId);
    await shop.admin.from("conversations").delete().eq("id", convo!.id);
    await shop.admin.from("modules").delete().eq("id", mod!.id);
  }
});
