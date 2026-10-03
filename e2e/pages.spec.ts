// A list of the store's, a page at a time from the whole of it (0167):
// the foot says where in all of it this is, a filter counts every row
// that fits, and a search finds a row that was never on screen.
import { expect, test } from "./shop";

test("a store list pages through all of it: its count, its pages, its search and filter", async ({
  signedIn: page,
  shop,
}) => {
  const headers = { Authorization: `Bearer ${(shop.session as { access_token: string }).access_token}` };
  const made = await page.request.post("/api/apply", {
    headers,
    data: {
      projectId: shop.projectId,
      plans: [
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          newModule: { name: "e2e-pages", nav_label: "All orders", icon: "table", source_table: "orders" },
          newSchema: null,
          features: { filters: [{ field: "financial_status", label: "Payment", options: ["PAID", "PENDING"] }] },
          explanation: "The store's orders, every one of them.",
        },
      ],
    },
  });
  expect(made.ok(), `the section is built: ${made.ok() ? "" : await made.text()}`).toBe(true);
  const { data: row } = await shop.admin
    .from("modules")
    .select("id")
    .eq("project_id", shop.projectId)
    .eq("name", "e2e-pages")
    .single();
  const id = row!.id as string;
  // Sixty more, a minute apart and newer than the shop's own, every third
  // unpaid: seventy in all. Taken away after, so no other spec sees them.
  const ahead = Date.now() + 86_400_000;
  const { error } = await shop.admin.from("orders").insert(
    Array.from({ length: 60 }, (_, i) => ({
      store_id: shop.storeId,
      external_id: `e2e-page-${shop.storeId.slice(0, 8)}-${i + 1}`,
      order_number: `#E2E-${String(i + 1).padStart(2, "0")}`,
      placed_at: new Date(ahead - i * 60_000).toISOString(),
      total: 100 + i,
      currency: "INR",
      financial_status: i % 3 === 0 ? "PENDING" : "PAID",
    }))
  );
  expect(error).toBeNull();
  const { count: all } = await shop.admin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("store_id", shop.storeId);
  const { count: unpaid } = await shop.admin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("store_id", shop.storeId)
    .eq("financial_status", "PENDING");

  try {
    await page.goto(`/app/${shop.projectId}?section=${id}`);
    // With pages, the pill says where and the foot of how many.
    const pages = page.getByRole("group", { name: "Pages" });
    const of = page.getByText(new RegExp(`^of ${all}$`));
    await expect(pages).toContainText("1–50", { timeout: 30_000 });
    await expect(of).toBeVisible();
    // The newest first, by the moment it was placed.
    await expect(page.getByRole("row").nth(1)).toContainText("#E2E-01");

    await page.getByRole("button", { name: "Next page" }).click();
    await expect(pages).toContainText(`51–${all}`);

    // How many a page, kept for the section.
    await page.getByRole("group", { name: "Rows a page" }).getByRole("button", { name: "25" }).click();
    await expect(pages).toContainText("1–25");
    await page.reload();
    await expect(pages).toContainText("1–25", { timeout: 30_000 });
    await expect(of).toBeVisible();

    // A search finds an order that was never on screen.
    await page.getByRole("searchbox").fill("#1003");
    await expect(page.getByText(/^1–1 of 1$/)).toBeVisible();
    await expect(page.getByRole("row").nth(1)).toContainText("#1003");
    await page.getByRole("searchbox").fill("");

    // A filter counts every row that fits, from choices of the whole list.
    await page.getByRole("button", { name: "Filter by Payment" }).click();
    await page.getByRole("option", { name: /Pending/i }).click();
    await expect(page.getByText(new RegExp(`^1–${Math.min(25, unpaid!)} of ${unpaid}$`))).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  } finally {
    await shop.admin.from("orders").delete().eq("store_id", shop.storeId).like("external_id", "e2e-page-%");
    await shop.admin.from("modules").delete().eq("id", id);
  }
});
