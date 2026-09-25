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
