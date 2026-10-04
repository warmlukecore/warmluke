// A thread of design cards draws each preview over the section it
// changes. Fifteen cards over one store list asked for its rows thirty-two
// times at once, and a merchant's longer thread ran the browser out of
// connections (ERR_INSUFFICIENT_RESOURCES, 4 Oct). One read now serves
// every card that asks for the same section.
import { expect, test } from "./shop";

test("a thread of design cards over one store list reads that list a few times, not once a card", async ({
  signedIn: page,
  shop,
}) => {
  const auth = { Authorization: `Bearer ${(shop.session as { access_token: string }).access_token}` };
  const made = await page.request.post("/api/apply", {
    headers: auth,
    data: {
      projectId: shop.projectId,
      plans: [
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          newModule: { name: "e2e-orders-cards", nav_label: "Orders two", icon: "table", source_table: "orders" },
          newSchema: null,
          explanation: "The store's orders.",
        },
      ],
    },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const { data: mod } = await shop.admin
    .from("modules")
    .select("id")
    .eq("project_id", shop.projectId)
    .eq("name", "e2e-orders-cards")
    .single();
  const { data: thread } = await shop.admin
    .from("conversations")
    .insert({ project_id: shop.projectId, title: "Many designs" })
    .select("id")
    .single();
  const t = Date.now();
  const messages = Array.from({ length: 15 }, (_, i) => {
    const reply = {
      type: "plans",
      message: `Design ${i}`,
      plans: [
        {
          changeType: "FIELD_ADD",
          targetModuleId: mod!.id,
          newFields: [{ field: `f${i}`, label: `F${i}`, type: "text" }],
          explanation: `Add F${i}.`,
        },
      ],
    };
    return [
      {
        conversation_id: thread!.id,
        role: "user",
        content: `ask ${i}`,
        payload: { kind: "user", text: `ask ${i}` },
        created_at: new Date(t + i * 2).toISOString(),
      },
      {
        conversation_id: thread!.id,
        role: "assistant",
        content: JSON.stringify(reply),
        payload: reply,
        created_at: new Date(t + i * 2 + 1).toISOString(),
      },
    ];
  }).flat();
  await shop.admin.from("messages").insert(messages);
  let reads = 0;
  page.on("request", (r) => {
    if (r.url().includes("/rest/v1/store_orders")) reads++;
  });
  try {
    await page.goto(`/app/${shop.projectId}?c=${thread!.id}`);
    await page.waitForTimeout(6_000);
    expect(reads, "store list reads for fifteen cards").toBeLessThanOrEqual(5);
  } finally {
    await shop.admin.from("conversations").delete().eq("id", thread!.id);
    await shop.admin.from("modules").delete().eq("id", mod!.id);
  }
});
