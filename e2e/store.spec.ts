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
