// Customize: a section's look changed by its owner without Luke (5 Oct,
// lib/view-edit.ts). A column renamed, one taken off the table and one
// moved, a filter from what the rows hold, the order rows open in: saved
// at once, with no model asked, kept as the owner's own version, and
// there when the section is opened again.
import { expect, test } from "./shop";

test("Customize renames, hides, moves, filters and orders a section, with no model asked", async ({
  signedIn: page,
  shop,
}) => {
  const made = await page.request.post("/api/apply", {
    headers: { Authorization: `Bearer ${(shop.session as { access_token: string }).access_token}` },
    data: {
      projectId: shop.projectId,
      plans: [
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          newModule: { name: "e2e-customize", nav_label: "Returns", icon: "table" },
          newSchema: {
            columns: [
              { field: "order_no", label: "Order", type: "text" },
              { field: "customer", label: "Customer", type: "text" },
              { field: "reason", label: "Reason", type: "dropdown" },
              { field: "amount", label: "Amount", type: "currency" },
            ],
          },
          features: null,
          explanation: "Returns to log.",
        },
      ],
    },
  });
  expect(made.ok()).toBe(true);
  const { data: mod } = await shop.admin
    .from("modules")
    .select("id")
    .eq("project_id", shop.projectId)
    .eq("name", "e2e-customize")
    .single();
  const id = mod!.id as string;
  try {
    await shop.admin.from("records").insert(
      [
        { order_no: "R-1", customer: "Asha", reason: "Size", amount: 900 },
        { order_no: "R-2", customer: "Ravi", reason: "Damaged", amount: 2400 },
        { order_no: "R-3", customer: "Meera", reason: "Size", amount: 300 },
      ].map((data) => ({ project_id: shop.projectId, module_id: id, data }))
    );
    let modelAsked = false;
    // A design is asked for by a POST; the thread list is read with a GET.
    await page.route("**/api/chat**", (route) => {
      if (route.request().method() === "POST") modelAsked = true;
      return route.continue();
    });
    await page.goto(`/app/${shop.projectId}?section=${id}`);
    await expect(page.getByRole("cell", { name: "R-2" })).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "Customize" }).click();
    const sheet = page.getByRole("dialog", { name: "Customize Returns" });
    await sheet.getByRole("textbox", { name: "Name of Customer" }).fill("Buyer");
    await sheet.getByRole("switch", { name: "Show Amount on the table" }).click();
    await sheet.getByRole("button", { name: "Move Reason up" }).click();
    // A filter is offered where the rows give it choices, the reasons; an amount by its lowest and highest.
    await expect(sheet.getByRole("switch", { name: "Filter by Amount" })).toBeVisible();
    await expect(sheet.getByText("Min and max, either left open")).toBeVisible();
    await sheet.getByRole("switch", { name: "Filter by Reason" }).click();
    // Lists are chosen from with the keys they answer to: a click scrolls the
    // sheet first, and a list closes when what carries it moves (ui/Select).
    await sheet.getByRole("button", { name: "Order rows by: none" }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect(sheet.getByRole("button", { name: "Order rows by: Amount" })).toBeVisible();
    await sheet.getByRole("button", { name: /^Which first: / }).click();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(sheet.getByRole("button", { name: "Which first: Highest or latest first" })).toBeVisible();
    await sheet.getByRole("button", { name: "Save" }).click();
    await expect(sheet).toHaveCount(0);

    // At once, on the table.
    const heads = page.getByRole("columnheader");
    await expect(heads.filter({ hasText: "Buyer" })).toHaveCount(1);
    await expect(heads.filter({ hasText: "Amount" })).toHaveCount(0);
    await expect(heads.first()).toContainText("Order");
    await expect(heads.nth(1)).toContainText("Reason");
    await expect(page.getByRole("button", { name: "Filter by Reason" })).toBeVisible();
    // The highest amount opens first, though Amount is off the table.
    await expect(page.getByRole("row").nth(1)).toContainText("R-2");

    // Kept as the owner's own version, said in words.
    const { data: v } = await shop.admin
      .from("ui_schemas")
      .select("created_by, change_description")
      .eq("module_id", id)
      .order("version", { ascending: false })
      .limit(1)
      .single();
    expect(v!.created_by).toBe("user");
    expect(v!.change_description).toMatch(/renamed "Customer" to "Buyer"/i);
    expect(modelAsked).toBe(false);

    // And opened again, it is as they left it.
    await page.reload();
    await expect(page.getByRole("columnheader", { name: /Buyer/ })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Customize" }).click();
    await expect(page.getByRole("switch", { name: "Show Amount on the table" })).toHaveAttribute(
      "aria-checked",
      "false"
    );
    await expect(page.getByRole("switch", { name: "Filter by Reason" })).toHaveAttribute("aria-checked", "true");
  } finally {
    await shop.admin.from("modules").delete().eq("id", id);
  }
});
