// Choosing a linked row fills the form from it, and narrows the next link
// to it (lib/links.ts, 5 Oct). A return links to the store's orders and to
// their items: the order is found by typing, its customer, phone and total
// fill in, the item list offers that order's items alone, choosing another
// order clears the item, and what the owner typed is theirs. Before, a
// link to a store's list offered no rows at all.
import { expect, test } from "./shop";

test("choosing an order fills the return, and its items alone are offered", async ({ signedIn: page, shop }) => {
  // An order with two items or more, and another, from the seeded shop itself.
  const { data: lines } = await shop.admin
    .from("store_order_items")
    .select("order_id, order_number, title")
    .eq("store_id", shop.storeId);
  const byOrder = new Map<string, { number: string; titles: string[] }>();
  for (const l of lines ?? []) {
    const o = byOrder.get(l.order_id) ?? { number: l.order_number as string, titles: [] as string[] };
    o.titles.push(l.title);
    byOrder.set(l.order_id, o);
  }
  const [orderId, order] = [...byOrder].find(([, o]) => o.titles.length >= 2)!;
  const [, other] = [...byOrder].find(([id]) => id !== orderId)!;
  const { data: placed } = await shop.admin
    .from("store_orders")
    .select("customer_name, customer_phone, total")
    .eq("id", orderId)
    .single();

  const made = await page.request.post("/api/apply", {
    headers: { Authorization: `Bearer ${(shop.session as { access_token: string }).access_token}` },
    data: {
      projectId: shop.projectId,
      plans: [
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          newModule: { name: "e2e-orders", nav_label: "Orders", icon: "shopping-cart", source_table: "orders" },
          newSchema: null,
          newRecords: null,
          explanation: "The store's orders.",
        },
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          newModule: { name: "e2e-items", nav_label: "Order items", icon: "receipt", source_table: "order_line_items" },
          newSchema: null,
          newRecords: null,
          explanation: "What is in each order.",
        },
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          newModule: { name: "e2e-returns", nav_label: "Returns", icon: "table" },
          newSchema: {
            columns: [
              { field: "order", label: "Order", type: "link", linkTo: "#e2e-orders" },
              { field: "item", label: "Item", type: "link", linkTo: "#e2e-items" },
              { field: "customer_name", label: "Customer", type: "text" },
              { field: "customer_phone", label: "Phone", type: "phone" },
              { field: "total", label: "Total", type: "currency" },
              { field: "reason", label: "Reason", type: "text" },
            ],
            view: { type: "table" },
          },
          newRecords: null,
          explanation: "A return against an order and one of its items.",
        },
      ],
    },
  });
  expect(made.ok()).toBe(true);
  const { data: mods } = await shop.admin.from("modules").select("id, name").eq("project_id", shop.projectId);
  const returns = mods!.find((m) => m.name === "e2e-returns")!.id as string;

  try {
    await page.goto(`/app/${shop.projectId}?section=${returns}`);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const form = page.getByRole("dialog");

    // The order is found by typing its number: a store's list, asked of the server.
    await form.getByRole("button", { name: "Order: none" }).click();
    await page.getByRole("combobox", { name: "Find Order" }).fill(order.number.replace("#", ""));
    await page
      .getByRole("option", { name: new RegExp(order.number) })
      .first()
      .click();

    // Its customer, phone and total fill in, and the form says so.
    await expect(form.getByRole("textbox", { name: "Customer" })).toHaveValue(placed!.customer_name);
    if (placed!.customer_phone) await expect(form.getByLabel("Phone")).toHaveValue(placed!.customer_phone);
    await expect(form.getByText(/^Filled .*Customer.* from /)).toBeVisible();

    // The item list offers this order's items alone.
    await form.getByRole("button", { name: "Item: none" }).click();
    const offered = page.getByRole("listbox", { name: "Item" }).getByRole("option");
    await expect(offered.filter({ hasText: order.titles[0] }).first()).toBeVisible();
    await expect(offered).toHaveCount(order.titles.length + 1); // and "—", to clear it
    await offered.filter({ hasText: order.titles[0] }).first().click();
    await expect(form.getByRole("button", { name: /^Item: (?!none)/ })).toBeVisible();

    // Another order: the item chosen for the first one no longer fits, and goes.
    await form.getByRole("button", { name: /^Order: / }).click();
    await page.getByRole("combobox", { name: "Find Order" }).fill(other.number.replace("#", ""));
    await page
      .getByRole("option", { name: new RegExp(other.number) })
      .first()
      .click();
    await expect(form.getByRole("button", { name: "Item: none" })).toBeVisible();

    // What the owner typed is theirs: choosing again leaves it.
    await form.getByRole("textbox", { name: "Customer" }).fill("Walk-in");
    await form.getByRole("button", { name: /^Order: / }).click();
    await page.getByRole("combobox", { name: "Find Order" }).fill(order.number.replace("#", ""));
    await page
      .getByRole("option", { name: new RegExp(order.number) })
      .first()
      .click();
    await expect(form.getByRole("textbox", { name: "Customer" })).toHaveValue("Walk-in");

    await form.getByRole("button", { name: "Add row" }).click();
    await expect(form).toHaveCount(0);
    await expect
      .poll(async () => {
        const { data } = await shop.admin.from("records").select("data").eq("module_id", returns);
        return (data ?? []).map((r) => (r.data as Record<string, unknown>).order);
      })
      .toEqual([orderId]);
    // And the table names the order, never "(deleted)".
    await expect(page.getByRole("cell", { name: new RegExp(order.number) }).first()).toBeVisible();
    await expect(page.getByText("(deleted)")).toHaveCount(0);
  } finally {
    await shop.admin
      .from("modules")
      .delete()
      .in(
        "id",
        mods!.filter((m) => m.name.startsWith("e2e-")).map((m) => m.id)
      );
  }
});
