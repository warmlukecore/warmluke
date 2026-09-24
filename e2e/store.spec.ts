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
