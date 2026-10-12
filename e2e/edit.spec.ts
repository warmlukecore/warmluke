// A list edited like a sheet (7 Oct): every column Shopify lets be
// changed, on any section over the store whoever built it, and every
// field of the section's own; a price or a status only by the merchant's
// own hand; typing kept while they look elsewhere, never dropped by
// leaving, and put back with Undo.
import type { Page } from "@playwright/test";
import { expect, test, type Shop } from "./shop";

/** A section through the build route, as Luke and their AI build one. */
async function build(page: Page, shop: Shop, plan: Record<string, unknown>): Promise<string> {
  const made = await page.request.post("/api/apply", {
    headers: { Authorization: `Bearer ${(shop.session as { access_token: string }).access_token}` },
    data: {
      projectId: shop.projectId,
      plans: [{ changeType: "NEW_MODULE", targetModuleId: null, newSchema: null, newRecords: null, ...plan }],
    },
  });
  expect(made.ok(), `the section was built: ${await made.text()}`).toBe(true);
  const name = (plan.newModule as { name: string }).name;
  const { data } = await shop.admin
    .from("modules")
    .select("id")
    .eq("project_id", shop.projectId)
    .eq("name", name)
    .single();
  return data!.id as string;
}

const section = (name: string, label: string, source: string | null) => ({
  newModule: { name, nav_label: label, icon: "table", ...(source ? { source_table: source } : {}) },
  explanation: "Edited in place.",
});

test("every column the store lets be changed is typed into, on any list over it, a price only by hand", async ({
  signedIn: page,
  shop,
}) => {
  const { data: was } = await shop.admin
    .from("account_settings")
    .select("store_actions_enabled")
    .eq("user_id", shop.userId)
    .maybeSingle();
  await shop.admin.from("account_settings").upsert({ user_id: shop.userId, store_actions_enabled: true });
  const { data: grant } = await shop.admin.from("stores").select("granted_scopes").eq("id", shop.storeId).single();
  await shop.admin
    .from("stores")
    .update({
      granted_scopes: [
        ...((grant?.granted_scopes as string[] | null) ?? []),
        "write_customers",
        "write_products",
        "write_inventory",
        "write_orders",
      ],
    })
    .eq("id", shop.storeId);
  const since = new Date().toISOString();
  const ids: string[] = [];
  const asked = async (action: string) =>
    (
      await shop.admin
        .from("store_actions")
        .select("status, targets")
        .eq("project_id", shop.projectId)
        .eq("action", action)
        .gte("created_at", since)
    ).data ?? [];
  try {
    ids.push(await build(page, shop, section("e2e-edit-customers", "People", "customers")));
    ids.push(await build(page, shop, section("e2e-edit-products", "Catalogue", "products")));
    ids.push(await build(page, shop, section("e2e-edit-variants", "Prices", "variants")));
    // Over the orders with fields of their own, as a packing design builds it.
    ids.push(
      await build(page, shop, {
        ...section("e2e-edit-packing", "Packing", "orders"),
        newSchema: {
          columns: [
            { field: "packed", label: "Packed", type: "boolean" },
            { field: "shelf", label: "Shelf", type: "text" },
          ],
        },
      })
    );
    const [people, catalogue, prices, packing] = ids;
    const bar = page.getByRole("region", { name: "Editing in place" });
    const edit = () => page.getByRole("button", { name: "Edit", exact: true }).click();

    // Customers: an email typed, and one that is not an email kept as typed, with why.
    await page.goto(`/app/${shop.projectId}?section=${people}`);
    await expect(page.getByRole("heading", { level: 1, name: "People" })).toBeVisible();
    await edit();
    const emails = page.getByRole("textbox", { name: /^Email of this row/ });
    await emails.nth(0).fill("aarav.new@example.com");
    await emails.nth(1).fill("not an email");
    // The first column too: a customer's name, beside the row's tick.
    await page
      .getByRole("textbox", { name: /^Name of this row/ })
      .nth(2)
      .fill("Rohan G");
    await expect(bar.getByText("3 changes, 1 to fix")).toBeVisible();
    await expect(emails.nth(1)).toHaveAttribute("aria-invalid", "true");
    await bar.getByRole("button", { name: "Save, for your yes" }).click();
    await expect(bar.getByText(/2 waiting in the bell for your yes/i)).toBeVisible();
    await expect(bar.getByText(/1 left as typed: "not an email" is not an email address/)).toBeVisible();
    await expect(emails.nth(1)).toHaveValue("not an email");
    const people1 = await asked("update_customer");
    expect(people1).toHaveLength(1);
    const lines = people1[0].targets as Array<{ set: Record<string, string>; was: Record<string, string> }>;
    expect(lines).toHaveLength(2);
    const line = lines.find((l) => "email" in l.set)!;
    expect(line.set).toEqual({ email: "aarav.new@example.com" });
    expect(Object.keys(line.was)).toEqual(["email"]);
    expect(lines.find((l) => "name" in l.set)?.set).toEqual({ name: "Rohan G" });
    await bar.getByRole("button", { name: "Discard" }).click();

    // Products: a status picked from its own words, not typed.
    await page.goto(`/app/${shop.projectId}?section=${catalogue}`);
    await expect(page.getByRole("heading", { level: 1, name: "Catalogue" })).toBeVisible();
    await edit();
    await page
      .getByRole("button", { name: /^Status of this row: Active/ })
      .first()
      .click();
    await page.getByRole("option", { name: "Draft" }).click();
    await bar.getByRole("button", { name: "Save, for your yes" }).click();
    await expect(bar.getByText(/1 waiting in the bell for your yes/i)).toBeVisible();
    const products = await asked("update_product");
    expect(products).toHaveLength(1);
    expect((products[0].targets as Array<{ set: Record<string, string> }>)[0].set).toEqual({ status: "DRAFT" });

    // Variants: a price, the merchant's own typing, aimed through its product.
    await page.goto(`/app/${shop.projectId}?section=${prices}`);
    await expect(page.getByRole("heading", { level: 1, name: "Prices" })).toBeVisible();
    await edit();
    await page
      .getByRole("textbox", { name: /^Price of this row/ })
      .nth(0)
      .fill("499.50");
    await bar.getByRole("button", { name: "Save, for your yes" }).click();
    await expect(bar.getByText(/1 waiting in the bell for your yes/i)).toBeVisible();
    const variants = await asked("update_variant");
    expect(variants).toHaveLength(1);
    const priced = variants[0].targets as Array<Record<string, unknown>>;
    expect(priced[0].set).toEqual({ price: "499.50" });
    expect(String(priced[0].productId)).toMatch(/^gid:\/\/shopify\/Product\//);

    // Over the orders: their own fields saved here, the store's tags typed too; Undo puts theirs back.
    await page.goto(`/app/${shop.projectId}?section=${packing}`);
    await expect(page.getByRole("heading", { level: 1, name: "Packing" })).toBeVisible();
    await edit();
    await expect(page.getByRole("textbox", { name: /^Tags of this row/ }).first()).toBeVisible();
    await page
      .getByRole("checkbox", { name: /^Packed of this row/ })
      .nth(0)
      .check();
    await page
      .getByRole("textbox", { name: /^Shelf of this row/ })
      .nth(0)
      .fill("A3");
    await expect(bar.getByText("2 changes")).toBeVisible();
    await bar.getByRole("button", { name: "Save", exact: true }).click();
    await expect(bar.getByText(/Saved on 1 row/)).toBeVisible();
    const kept = async () =>
      (await shop.admin.from("records").select("data").eq("module_id", packing)).data?.map(
        (r) => r.data as Record<string, unknown>
      ) ?? [];
    await expect.poll(async () => (await kept()).some((d) => d.shelf === "A3" && d.packed === true)).toBe(true);
    await bar.getByRole("button", { name: "Undo" }).click();
    await expect(bar.getByText(/Put back on 1 row/)).toBeVisible();
    await expect.poll(async () => (await kept()).some((d) => d.shelf === "A3")).toBe(false);
    await expect(bar.getByRole("button", { name: "Redo" })).toBeVisible();
  } finally {
    await shop.admin.from("store_actions").delete().eq("project_id", shop.projectId).gte("created_at", since);
    await shop.admin
      .from("stores")
      .update({ granted_scopes: grant?.granted_scopes ?? null })
      .eq("id", shop.storeId);
    await shop.admin
      .from("account_settings")
      .upsert({ user_id: shop.userId, store_actions_enabled: was?.store_actions_enabled ?? false });
    for (const id of ids) await shop.admin.from("modules").delete().eq("id", id);
  }
});

test("a section of their own is edited like a sheet: kept while they look elsewhere, never dropped by leaving", async ({
  signedIn: page,
  shop,
}) => {
  const id = await build(page, shop, {
    ...section("e2e-edit-own", "Jobs", null),
    newSchema: {
      columns: [
        { field: "job", label: "Job", type: "text" },
        { field: "qty", label: "Qty", type: "number" },
        { field: "done", label: "Done", type: "boolean" },
      ],
    },
    newRecords: [
      { job: "Pack hampers", qty: 2, done: false },
      { job: "Restock shelf", qty: 7, done: false },
    ],
  });
  const qtyOf = async (job: string) =>
    ((await shop.admin.from("records").select("data").eq("module_id", id)).data ?? [])
      .map((r) => r.data as { job?: string; qty?: unknown })
      .find((d) => d.job === job)?.qty;
  try {
    await page.goto(`/app/${shop.projectId}?section=${id}`);
    await expect(page.getByRole("heading", { level: 1, name: "Jobs" })).toBeVisible();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const bar = page.getByRole("region", { name: "Editing in place" });
    const qty = () =>
      page.getByRole("row", { name: /Pack hampers/ }).getByRole("textbox", { name: /^Qty of this row/ });
    await qty().fill("x");
    await expect(qty()).toHaveAttribute("aria-invalid", "true");
    await qty().fill("5");

    // Looked elsewhere and back: still typed, still editing.
    await page.goto(`/app/${shop.projectId}`);
    await page.goto(`/app/${shop.projectId}?section=${id}`);
    await expect(qty()).toHaveValue("5");
    await expect(bar.getByText("1 change")).toBeVisible();

    // Not dropped by leaving edit mode: asked plainly, with the choice right there.
    await page.getByRole("button", { name: "Done editing" }).click();
    const asked = bar.getByRole("alert");
    await expect(asked).toContainText("1 change isn't saved.");
    await expect(asked.getByRole("button", { name: "Save and finish" })).toBeFocused();
    await asked.getByRole("button", { name: "Keep editing" }).click();
    await expect(asked).toHaveCount(0);
    await bar.getByRole("button", { name: "Save", exact: true }).click();
    await expect(bar.getByText(/Saved on 1 row/)).toBeVisible();
    await expect.poll(() => qtyOf("Pack hampers")).toBe(5);
    await bar.getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => qtyOf("Pack hampers")).toBe(2);
    await bar.getByRole("button", { name: "Redo" }).click();
    await expect.poll(() => qtyOf("Pack hampers")).toBe(5);

    // Typed again and let go in one press, edit mode with it.
    await qty().fill("9");
    await page.getByRole("button", { name: "Done editing" }).click();
    await asked.getByRole("button", { name: "Discard and finish" }).click();
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
    expect(await qtyOf("Pack hampers")).toBe(5);

    // Or saved and finished in one: what went, and its Undo, said under the table.
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await qty().fill("6");
    await page.getByRole("button", { name: "Done editing" }).click();
    await asked.getByRole("button", { name: "Save and finish" }).click();
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
    await expect.poll(() => qtyOf("Pack hampers")).toBe(6);
    const done = page.getByRole("region", { name: "What was done" });
    await expect(done.getByText(/Saved on 1 row/)).toBeVisible();
    await done.getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => qtyOf("Pack hampers")).toBe(5);
  } finally {
    await shop.admin.from("modules").delete().eq("id", id);
  }
});

test("ticked rows of their own are acted on from Actions: a field set starts empty each time, rows go after a yes, and a column says what it means", async ({
  signedIn: page,
  shop,
}) => {
  const id = await build(page, shop, {
    ...section("e2e-actions-own", "Blanks", null),
    newSchema: {
      columns: [
        { field: "sku", label: "SKU", type: "text" },
        { field: "parent", label: "Parent SKU", type: "text" },
        { field: "left", label: "Left", type: "number" },
      ],
    },
    newRecords: [
      { sku: "A-1", parent: "", left: 3 },
      { sku: "A-2", parent: "", left: 5 },
      { sku: "A-3", parent: "", left: 8 },
    ],
  });
  // What a column means, kept on the section (SchemaColumn.about).
  const { data: ui } = await shop.admin
    .from("ui_schemas")
    .select("id, schema_json")
    .eq("module_id", id)
    .order("version", { ascending: false })
    .limit(1)
    .single();
  const schemaJson = ui!.schema_json as { columns: Array<Record<string, unknown>> };
  await shop.admin
    .from("ui_schemas")
    .update({
      schema_json: {
        ...schemaJson,
        columns: schemaJson.columns.map((c) =>
          c.field === "left" ? { ...c, about: "Blanks still on the shelf, counted by hand." } : c
        ),
      },
    })
    .eq("id", ui!.id);
  const rows = async () =>
    ((await shop.admin.from("records").select("data").eq("module_id", id)).data ?? []).map(
      (r) => r.data as { sku: string; parent?: string }
    );
  try {
    await page.goto(`/app/${shop.projectId}?section=${id}`);
    await expect(page.getByRole("heading", { level: 1, name: "Blanks" })).toBeVisible();

    // The meaning sits behind an i, pressed or focused, and the name stays short.
    await page.getByRole("button", { name: "What Left means" }).click();
    await expect(page.getByRole("note")).toContainText("Blanks still on the shelf, counted by hand.");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("note")).toHaveCount(0);

    // One button beside Edit, waiting for a tick; ticking moves nothing above the rows.
    await expect(page.getByRole("button", { name: "Actions: tick rows first" })).toBeDisabled();
    const first = page.getByRole("row", { name: /A-1/ });
    const before = (await first.boundingBox())!.y;
    const ticks = page.getByRole("checkbox", { name: "Tick this row" });
    await ticks.nth(0).click();
    await ticks.nth(1).click();
    expect((await first.boundingBox())!.y).toBe(before);

    // A field set on both, from its own dialog.
    await page.getByRole("button", { name: "Actions on 2 ticked rows" }).click();
    await page.getByRole("menuitem", { name: "Set a field…" }).click();
    const set = page.getByRole("dialog", { name: "Set a field on 2 rows" });
    await set.getByRole("button", { name: /^Field to set/ }).click();
    await page.getByRole("option", { name: "Parent SKU" }).click();
    await set.getByRole("textbox", { name: "Parent SKU" }).fill("POX-SL");
    await set.getByRole("button", { name: "Set on 2" }).click();
    const done = page.getByRole("region", { name: "What was done" });
    await expect(done.getByText("Parent SKU set: done on 2.")).toBeVisible();
    await expect.poll(async () => (await rows()).filter((r) => r.parent === "POX-SL").length).toBe(2);

    // Ticked again, it opens empty: nothing kept from the last time (Tanish, 12 Oct).
    await ticks.nth(2).click();
    await page.getByRole("button", { name: "Actions on 1 ticked row" }).click();
    await page.getByRole("menuitem", { name: "Set a field…" }).click();
    const again = page.getByRole("dialog", { name: "Set a field on 1 row" });
    await expect(again.getByRole("button", { name: "Field to set: none" })).toBeVisible();
    await expect(again.getByRole("button", { name: "Set on 1" })).toBeDisabled();
    await again.getByRole("button", { name: "Cancel" }).click();

    // Deleted after a yes, in one request; Cancel deletes nothing.
    await page.getByRole("button", { name: "Actions on 1 ticked row" }).click();
    await page.getByRole("menuitem", { name: "Delete 1 row…" }).click();
    const sure = page.getByRole("dialog", { name: "Delete 1 row?" });
    await expect(sure.getByText(/can.t be undone/)).toBeVisible();
    await sure.getByRole("button", { name: "Cancel" }).click();
    expect(await rows()).toHaveLength(3);
    await page.getByRole("button", { name: "Actions on 1 ticked row" }).click();
    await page.getByRole("menuitem", { name: "Delete 1 row…" }).click();
    await sure.getByRole("button", { name: "Delete 1 row" }).click();
    await expect(done.getByText("Deleted 1 row.")).toBeVisible();
    await expect(page.getByRole("row", { name: /A-3/ })).toHaveCount(0);
    expect((await rows()).map((r) => r.sku).sort()).toEqual(["A-1", "A-2"]);
  } finally {
    await shop.admin.from("modules").delete().eq("id", id);
  }
});
