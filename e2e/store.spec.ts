// A merchant with a shop opens the app and sees that shop.
import { expect, test } from "./shop";

test("the shop opens on its own overview, newest orders first", async ({ signedIn: page, shop }) => {
  await page.goto(`/app/${shop.projectId}`);
  // Ten seeded orders over four weeks, counted on the server.
  await expect(page.getByRole("img", { name: /Orders per day over the last \d+ days, \d+ in all/ })).toBeVisible();
  const latest = page.getByText("Latest orders").locator("xpath=ancestor::*[.//text()[contains(., '#10')]][1]");
  await expect(latest.getByText("#1010")).toBeVisible();
  await expect(latest.getByText("#1001")).toHaveCount(0);
});

test("rows a check did not bring back are named, with the check that settles it", async ({ signedIn: page, shop }) => {
  // What a finished check answers when rows did not come back, and when
  // an earlier miss was confirmed and taken. The import route is answered
  // here: the shop behind this store is not a real one, so no check of
  // it can finish. What the server decides is check-drift's to prove.
  await page.route("**/api/shopify/import", async (route) => {
    const asked = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    const progress = {
      products: { imported: 6, status: "done", label: "products" },
      customers: { imported: 5, status: "done", label: "customers" },
    };
    if (asked.status) return route.fulfill({ json: { done: false, progress } });
    if (asked.kick) return route.fulfill({ json: { kicked: "not_configured" } });
    return route.fulfill({
      json: {
        done: true,
        progress,
        drift: { products: { missing: 3, examples: ["Cotton Kurta", "Silk Saree"] } },
        removed: { customers: 1 },
      },
    });
  });
  await page.goto(`/app/${shop.projectId}`);
  // Below the wide layout the store sits in the sections drawer.
  if ((page.viewportSize()?.width ?? 0) < 1024) await page.getByRole("button", { name: "Open sections" }).click();
  const line = page.getByRole("status").filter({ hasText: "3 products missing" });
  await expect(line).toBeVisible();
  // Named, with how many more, and offered the check that settles it,
  // not a reconnect that cannot.
  await expect(line.locator("[title]")).toHaveAttribute(
    "title",
    "3 products (Cotton Kurta, Silk Saree, …) did not come back on the last check, most likely deleted in Shopify. If the next check agrees, they are removed here."
  );
  await expect(line.getByRole("button", { name: "Check", exact: true })).toBeVisible();
  await expect(line.getByRole("button", { name: "Reconnect" })).toHaveCount(0);
  // What was taken is said once, quietly, under the sync time.
  await expect(page.getByText("Removed 1 customer", { exact: true })).toBeVisible();
});

test("a field of the merchant's sits on the store's own orders: set by a button, kept, and edited on the order", async ({
  signedIn: page,
  shop,
}) => {
  // A section over the orders with a field of the merchant's beside
  // Shopify's, as a packing design builds it: no second list of orders.
  // Through the build route, so the design's gates are the real ones.
  const made = await page.request.post("/api/apply", {
    headers: { Authorization: `Bearer ${(shop.session as { access_token: string }).access_token}` },
    data: {
      projectId: shop.projectId,
      plans: [
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          newModule: { name: "e2e-packing", nav_label: "Packing", icon: "table", source_table: "orders" },
          newSchema: {
            columns: [
              { field: "packed", label: "Packed", type: "boolean" },
              { field: "shelf", label: "Shelf", type: "text" },
            ],
          },
          features: {
            actions: [
              {
                label: "Mark packed",
                set: { packed: { const: true } },
                when: { op: "not", args: [{ field: "packed" }] },
              },
            ],
          },
          newRecords: null,
          explanation: "The store's orders, with a packed tick and a shelf beside each.",
        },
      ],
    },
  });
  expect(made.ok(), `the section was built: ${await made.text()}`).toBe(true);
  const { data: mod } = await shop.admin
    .from("modules")
    .select("id")
    .eq("project_id", shop.projectId)
    .eq("name", "e2e-packing")
    .single();
  const id = mod!.id as string;
  try {
    await page.goto(`/app/${shop.projectId}?section=${id}`);
    await expect(page.getByRole("heading", { level: 1, name: "Packing" })).toBeVisible();
    const order = page.getByRole("row").filter({ hasText: "#1010" });
    // The order's number reads as a code, so it copies — without opening the row.
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await order.getByRole("button", { name: "Copy #1010" }).click();
    await expect(order.getByRole("button", { name: "Copied" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your fields" })).toHaveCount(0);
    await order.getByRole("button", { name: "Mark packed" }).click();
    // Packed, the button has done its work, and it stays so on a reload.
    await expect(order.getByRole("button", { name: "Mark packed" })).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("row").filter({ hasText: "#1009" }).getByRole("button", { name: "Mark packed" })
    ).toBeVisible();
    await expect(order.getByRole("button", { name: "Mark packed" })).toHaveCount(0);

    // The order opens with the store's facts, and the merchant's fields to fill in.
    await order.click();
    const mine = page.locator("section").filter({ has: page.getByRole("heading", { name: "Your fields" }) });
    await expect(mine.locator("button[aria-pressed]")).toHaveAttribute("aria-pressed", "true");
    await mine.getByRole("textbox").fill("B2");
    await mine.getByRole("button", { name: "Save" }).click();
    await expect(mine.getByRole("status")).toHaveText("Saved");
    await expect(mine.getByRole("button", { name: "Save" })).toBeDisabled();
    const { data: kept } = await shop.admin.from("records").select("data").eq("module_id", id);
    expect(kept).toHaveLength(1);
    expect(kept![0].data).toMatchObject({ packed: true, shelf: "B2" });
  } finally {
    await shop.admin.from("modules").delete().eq("id", id);
  }
});

test("a price between two: Min and Max narrow the whole list, and its cards with it", async ({
  signedIn: page,
  shop,
}) => {
  // A section over the orders with a filter by its total, sent as a
  // design sends it (as bands); the validator makes it a lowest and a
  // highest (Tanish, 6 Oct: their AI said a Min / Max price could not be built).
  const made = await page.request.post("/api/apply", {
    headers: { Authorization: `Bearer ${(shop.session as { access_token: string }).access_token}` },
    data: {
      projectId: shop.projectId,
      plans: [
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          newModule: { name: "e2e-priced", nav_label: "Priced", icon: "table", source_table: "orders" },
          newSchema: null,
          features: {
            filters: [{ field: "total", label: "Total", options: ["Under 1000", "1000 and up"] }],
            stats: [{ label: "Orders in view", op: "count" }],
          },
          newRecords: null,
          explanation: "The store's orders, to narrow by what they came to.",
        },
      ],
    },
  });
  expect(made.ok(), `the section was built: ${await made.text()}`).toBe(true);
  const { data: mod } = await shop.admin
    .from("modules")
    .select("id")
    .eq("project_id", shop.projectId)
    .eq("name", "e2e-priced")
    .single();
  const id = mod!.id as string;
  const { data: orders } = await shop.admin.from("orders").select("total").eq("store_id", shop.storeId);
  const totals = (orders ?? []).map((o) => Number(o.total)).sort((a, b) => a - b);
  const [low, high] = [totals[2], totals[totals.length - 3]];
  const inside = totals.filter((t) => t >= low && t <= high).length;
  try {
    await page.goto(`/app/${shop.projectId}?section=${id}`);
    await expect(page.getByRole("heading", { level: 1, name: "Priced" })).toBeVisible();
    const rows = page.getByRole("row").filter({ hasText: /#10\d\d/ });
    await expect(rows).toHaveCount(totals.length);
    const card = page.locator("div.shadow-card").filter({
      has: page.getByRole("button", { name: "How Orders in view is worked out" }),
    });
    await expect(card).toContainText(String(totals.length));

    await page.getByRole("button", { name: "Filter by Total" }).click();
    const box = page.getByRole("dialog", { name: "Total, lowest and highest" });
    await box.getByRole("textbox", { name: "Min" }).fill(String(low));
    await box.getByRole("textbox", { name: "Max" }).fill(String(high));
    await box.getByRole("button", { name: "Apply" }).click();
    await expect(rows).toHaveCount(inside);
    await expect(card).toContainText(String(inside));
    await expect(page.getByRole("button", { name: /^Filter by Total: / })).toBeVisible();

    // A lowest above the highest is said, and narrows nothing.
    await page.getByRole("button", { name: /^Filter by Total: / }).click();
    await box.getByRole("textbox", { name: "Min" }).fill(String(high + 1));
    await expect(box.getByText("Min is above Max.")).toBeVisible();
    await expect(box.getByRole("button", { name: "Apply" })).toBeDisabled();
    await box.getByRole("button", { name: "Clear" }).click();
    await expect(rows).toHaveCount(totals.length);
    await expect(card).toContainText(String(totals.length));
  } finally {
    await shop.admin.from("modules").delete().eq("id", id);
  }
});

test("stock changed on ticked rows waits for the owner's yes, and goes straight once they turn it on, their yes kept", async ({
  signedIn: page,
  shop,
}) => {
  const wide = (page.viewportSize()?.width ?? 0) >= 1024;
  // Changing a store at all is an administrator's switch per account (0107).
  const { data: was } = await shop.admin
    .from("account_settings")
    .select("store_actions_enabled")
    .eq("user_id", shop.userId)
    .maybeSingle();
  await shop.admin.from("account_settings").upsert({ user_id: shop.userId, store_actions_enabled: true });
  // And Shopify has allowed it, as a store reconnected with stock writes has.
  const { data: grant } = await shop.admin.from("stores").select("granted_scopes").eq("id", shop.storeId).single();
  await shop.admin
    .from("stores")
    .update({ granted_scopes: [...((grant?.granted_scopes as string[] | null) ?? []), "write_inventory"] })
    .eq("id", shop.storeId);
  const made = await page.request.post("/api/apply", {
    headers: { Authorization: `Bearer ${(shop.session as { access_token: string }).access_token}` },
    data: {
      projectId: shop.projectId,
      plans: [
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          newModule: { name: "e2e-counts", nav_label: "Counts", icon: "table", source_table: "inventory_levels" },
          newSchema: null,
          newRecords: null,
          explanation: "The store's stock, to count.",
        },
      ],
    },
  });
  expect(made.ok(), `the section was built: ${await made.text()}`).toBe(true);
  const { data: mod } = await shop.admin
    .from("modules")
    .select("id")
    .eq("project_id", shop.projectId)
    .eq("name", "e2e-counts")
    .single();
  const id = mod!.id as string;
  const since = new Date().toISOString();
  const asked = async () =>
    (
      await shop.admin
        .from("store_actions")
        .select("status, targets, approved_by")
        .eq("project_id", shop.projectId)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
    ).data ?? [];
  try {
    await page.goto(`/app/${shop.projectId}?section=${id}`);
    await expect(page.getByRole("heading", { level: 1, name: "Counts" })).toBeVisible();
    const ticks = page.getByRole("checkbox", { name: "Tick this row" });
    await ticks.nth(0).click();
    await ticks.nth(1).click();
    const bar = page.getByRole("region", { name: "Act on the ticked rows" });
    await expect(bar.getByText("Set a stock count in Shopify")).toBeVisible();
    await bar.getByRole("textbox", { name: "Count" }).fill("37");
    // Off until the owner turns it on: their change waits in the bell.
    await bar.getByRole("button", { name: "Ask for your yes (2)" }).click();
    await expect(bar.getByText(/2 waiting in the bell for your yes/)).toBeVisible();
    const first = await asked();
    expect(first[0]?.status).toBe("pending");
    expect(((first[0]?.targets ?? []) as Array<{ quantity: number }>).map((t) => t.quantity)).toEqual([37, 37]);
    await bar.getByRole("button", { name: "Done" }).click();

    // Turned on in Settings, having read what it means; the words kept with the yes.
    if (!wide) await page.getByRole("button", { name: "Open sections" }).click();
    await page.getByRole("button", { name: "Project settings" }).click();
    await page.getByRole("tab", { name: "Store" }).click();
    const counts = page.getByRole("switch", { name: 'Send "Set a stock count" straight to Shopify' });
    await expect(counts).toHaveAttribute("aria-checked", "false");
    await counts.click();
    const sure = page.getByRole("dialog", { name: "Send straight to Shopify?" });
    await expect(sure.getByText(/at once, without asking you again/)).toBeVisible();
    await sure.getByRole("button", { name: "Turn on" }).click();
    await expect(counts).toHaveAttribute("aria-checked", "true");
    const { data: kept } = await shop.admin
      .from("store_send_consents")
      .select("action, turned_on, said, user_id")
      .eq("project_id", shop.projectId);
    expect(kept).toHaveLength(1);
    expect(kept![0]).toMatchObject({ action: "set_stock", turned_on: true, user_id: shop.userId });
    expect(kept![0].said).toMatch(/without asking you again/);
    await page.keyboard.press("Escape");

    // Now theirs goes straight: approved as their yes and tried on Shopify
    // (this store is not a real one, so the try is said, not dropped).
    await ticks.nth(0).click();
    await bar.getByRole("textbox", { name: "Count" }).fill("38");
    await bar.getByRole("button", { name: "Send to Shopify (1)" }).click();
    await expect(bar.getByText(/^Set a stock count: (updated in Shopify|one not done)/)).toBeVisible({
      timeout: 30_000,
    });
    const second = await asked();
    expect(["done", "partly_done", "failed"]).toContain(second[0]?.status);
    expect(second[0]?.approved_by).toBe(shop.userId);
  } finally {
    await shop.admin.from("store_actions").delete().eq("project_id", shop.projectId).gte("created_at", since);
    await shop.admin.from("store_send_consents").delete().eq("project_id", shop.projectId);
    await shop.admin
      .from("stores")
      .update({ auto_send: [], granted_scopes: grant?.granted_scopes ?? null })
      .eq("id", shop.storeId);
    await shop.admin
      .from("account_settings")
      .upsert({ user_id: shop.userId, store_actions_enabled: was?.store_actions_enabled ?? false });
    await shop.admin.from("modules").delete().eq("id", id);
  }
});

test("stock edited in place: typed into its cell, waits for the owner's yes, saved straight once that is on; a column keeps the width it was given", async ({
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
    .update({ granted_scopes: [...((grant?.granted_scopes as string[] | null) ?? []), "write_inventory"] })
    .eq("id", shop.storeId);
  const made = await page.request.post("/api/apply", {
    headers: { Authorization: `Bearer ${(shop.session as { access_token: string }).access_token}` },
    data: {
      projectId: shop.projectId,
      plans: [
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          newModule: { name: "e2e-counts-edit", nav_label: "Counts", icon: "table", source_table: "inventory_levels" },
          newSchema: null,
          newRecords: null,
          explanation: "The store's stock, to count in place.",
        },
      ],
    },
  });
  expect(made.ok(), `the section was built: ${await made.text()}`).toBe(true);
  const { data: mod } = await shop.admin
    .from("modules")
    .select("id")
    .eq("project_id", shop.projectId)
    .eq("name", "e2e-counts-edit")
    .single();
  const id = mod!.id as string;
  const since = new Date().toISOString();
  const asked = async () =>
    (
      await shop.admin
        .from("store_actions")
        .select("status, targets, approved_by")
        .eq("project_id", shop.projectId)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
    ).data ?? [];
  try {
    await page.goto(`/app/${shop.projectId}?section=${id}`);
    await expect(page.getByRole("heading", { level: 1, name: "Counts" })).toBeVisible();

    // A column given a width keeps it, on this device.
    const edge = page.getByRole("separator", { name: "Width of Product" });
    const head = page.getByRole("columnheader", { name: /Product/ });
    const before = (await head.boundingBox())!.width;
    await edge.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await head.boundingBox())!.width).toBeGreaterThan(before + 30);

    // Typed into its cell: off until the owner turns it on, so it waits for their yes.
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const bar = page.getByRole("region", { name: "Editing in place" });
    const cells = page.getByRole("textbox", { name: /^Available of this row/ });
    // Enter goes down the column, Escape puts a cell back.
    await cells.nth(0).fill("7");
    await cells.nth(0).press("Enter");
    await expect(cells.nth(1)).toBeFocused();
    await cells.nth(0).focus();
    await cells.nth(0).press("Escape");
    await expect(bar.getByText("Type into a cell to change it")).toBeVisible();
    await cells.nth(0).fill("41");
    await expect(bar.getByText("1 change")).toBeVisible();
    await bar.getByRole("button", { name: "Save, for your yes" }).click();
    await expect(bar.getByText(/1 waiting in the bell for your yes/)).toBeVisible();
    const first = await asked();
    expect(first[0]?.status).toBe("pending");
    expect(((first[0]?.targets ?? []) as Array<{ quantity: number }>)[0]?.quantity).toBe(41);
    // The way to send straight is one press away.
    await bar.getByRole("button", { name: "Save straight to Shopify instead" }).click();
    await expect(page.getByRole("tab", { name: "Store" })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");

    // On (as Settings turns it on): the owner's edit goes now, and is tried on Shopify.
    await shop.admin
      .from("stores")
      .update({ auto_send: ["set_stock"] })
      .eq("id", shop.storeId);
    await page.reload();
    await expect(head).toBeVisible();
    expect((await head.boundingBox())!.width).toBeGreaterThan(before + 30);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await cells.nth(0).fill("42");
    await bar.getByRole("button", { name: "Save to Shopify" }).click();
    await expect(bar.getByText(/updated in Shopify|not done/i)).toBeVisible({ timeout: 30_000 });
    const second = await asked();
    expect(["done", "partly_done", "failed"]).toContain(second[0]?.status);
    expect(second[0]?.approved_by).toBe(shop.userId);

    // A count that is not one is never sent: it stays typed in, and says why.
    // (A change Shopify refused stays typed in too: put it away first.)
    const discard = bar.getByRole("button", { name: "Discard" });
    if (await discard.isVisible()) await discard.click();
    await cells.nth(1).fill("-3");
    await expect(cells.nth(1)).toHaveAttribute("aria-invalid", "true");
    await expect(bar.getByText("1 change, 1 to fix")).toBeVisible();
    await bar.getByRole("button", { name: "Save", exact: true }).click();
    await expect(bar.getByText(/1 can't be saved yet: A count is a whole number of 0 or more/)).toBeVisible();
    await expect(cells.nth(1)).toHaveValue("-3");
    expect((await asked()).length).toBe(second.length);
  } finally {
    await shop.admin.from("store_actions").delete().eq("project_id", shop.projectId).gte("created_at", since);
    await shop.admin
      .from("stores")
      .update({ auto_send: [], granted_scopes: grant?.granted_scopes ?? null })
      .eq("id", shop.storeId);
    await shop.admin
      .from("account_settings")
      .upsert({ user_id: shop.userId, store_actions_enabled: was?.store_actions_enabled ?? false });
    await shop.admin.from("modules").delete().eq("id", id);
  }
});

test("a stock count that went through is put back with Undo, asked for as any change is", async ({
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
    .update({ granted_scopes: [...((grant?.granted_scopes as string[] | null) ?? []), "write_inventory"] })
    .eq("id", shop.storeId);
  const headers = { Authorization: `Bearer ${(shop.session as { access_token: string }).access_token}` };
  const made = await page.request.post("/api/apply", {
    headers,
    data: {
      projectId: shop.projectId,
      plans: [
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          newModule: { name: "e2e-counts-undo", nav_label: "Counts", icon: "table", source_table: "inventory_levels" },
          newSchema: null,
          newRecords: null,
          explanation: "The store's stock, to count in place.",
        },
      ],
    },
  });
  expect(made.ok(), `the section was built: ${await made.text()}`).toBe(true);
  const { data: mod } = await shop.admin
    .from("modules")
    .select("id")
    .eq("project_id", shop.projectId)
    .eq("name", "e2e-counts-undo")
    .single();
  const id = mod!.id as string;
  const since = new Date().toISOString();
  // The check store has no Shopify behind it: the save is answered as a
  // real store answers one that went through, and kept as it would be.
  await page.route("**/api/store-actions", async (route) => {
    const body = route.request().postDataJSON() as {
      do?: string;
      action?: string;
      targets?: Array<{ id: string } & Record<string, unknown>>;
      params?: Record<string, unknown>;
    };
    if (body.do !== "ask") return route.continue();
    const targets = (body.targets ?? []).map((t) => ({ ...t, from: 3 }));
    const now = new Date().toISOString();
    const { data: row, error } = await shop.admin
      .from("store_actions")
      .insert({
        project_id: shop.projectId,
        store_id: shop.storeId,
        requested_by: shop.userId,
        action: body.action,
        targets,
        params: body.params ?? {},
        summary: "Sets the count of one item",
        status: "done",
        approved_by: shop.userId,
        approved_at: now,
        ran_at: now,
        resolved_at: now,
        outcome: { done: targets.map((t) => t.id), errors: [] },
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return route.fulfill({
      json: { status: "done", done: targets.map((t) => t.id), errors: [], actionId: row!.id, summary: "" },
    });
  });
  try {
    await page.goto(`/app/${shop.projectId}?section=${id}`);
    await expect(page.getByRole("heading", { level: 1, name: "Counts" })).toBeVisible();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const bar = page.getByRole("region", { name: "Editing in place" });
    await page
      .getByRole("textbox", { name: /^Available of this row/ })
      .nth(0)
      .fill("41");
    await bar.getByRole("button", { name: "Save, for your yes" }).click();
    await expect(bar.getByText(/updated in Shopify on 1/i)).toBeVisible();

    // Undo asks for the opposite: the count it had, from the count it was set to,
    // so Shopify refuses it if a sale moved it since. Off, it waits for their yes.
    await bar.getByRole("button", { name: "Undo" }).click();
    await expect(bar.getByText(/putting it back waits in the bell for your yes/i)).toBeVisible();
    const { data: back } = await shop.admin
      .from("store_actions")
      .select("id, action, status, targets")
      .eq("project_id", shop.projectId)
      .eq("status", "pending")
      .gte("created_at", since);
    expect(back?.length).toBe(1);
    const line = (back![0].targets as Array<{ quantity: number; from: number }>)[0];
    expect([back![0].action, line.quantity, line.from]).toEqual(["set_stock", 3, 41]);

    // Only what went through is put back, and only by someone who can see it.
    const pending = await page.request.post("/api/store-actions", {
      headers,
      data: { do: "undo", actionId: back![0].id },
    });
    expect(pending.status()).toBe(400);
    const stranger = await page.request.post("/api/store-actions", {
      headers,
      data: { do: "undo", actionId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(stranger.status()).toBe(404);

    // In the bell too, whoever asked for it: a change that went through puts back from its card.
    if ((page.viewportSize()?.width ?? 0) < 1024) await page.getByRole("button", { name: /^Luke/ }).first().click();
    const panel = page.getByRole("complementary", { name: "Luke" });
    await panel.getByRole("button", { name: /want your attention/ }).click();
    await panel.getByRole("tab", { name: /Asked for/ }).click();
    await panel.getByRole("button", { name: "Undo" }).click();
    await expect(panel.getByText("Putting it back is waiting for a yes, here.")).toBeVisible();
    const { count } = await shop.admin
      .from("store_actions")
      .select("id", { count: "exact", head: true })
      .eq("project_id", shop.projectId)
      .eq("status", "pending")
      .gte("created_at", since);
    expect(count).toBe(2);
  } finally {
    await shop.admin.from("store_actions").delete().eq("project_id", shop.projectId).gte("created_at", since);
    await shop.admin
      .from("stores")
      .update({ granted_scopes: grant?.granted_scopes ?? null })
      .eq("id", shop.storeId);
    await shop.admin
      .from("account_settings")
      .upsert({ user_id: shop.userId, store_actions_enabled: was?.store_actions_enabled ?? false });
    await shop.admin.from("modules").delete().eq("id", id);
  }
});
