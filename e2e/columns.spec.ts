// A section's columns as the owner sees them (3 Oct, an RTO section):
// a yes/no field is a tick or nothing, filtered as Yes or No, where No is
// every row not ticked; and a hidden column is off the table and still in
// the row when it is opened.
import { expect, test } from "./shop";

test("a tick is a tick or nothing, filtered Yes or No; a hidden column is in the row, not the table", async ({
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
          newModule: { name: "e2e-ticks", nav_label: "Ticks", icon: "table" },
          newSchema: {
            columns: [
              { field: "order_number", label: "Order", type: "text" },
              { field: "rto", label: "RTO", type: "boolean" },
              { field: "rto_note", label: "RTO note", type: "longtext", hidden: true },
            ],
          },
          // Sent with no choices, as a tick needs none: it is Yes / No by itself.
          features: { filters: [{ field: "rto", label: "RTO" }] },
          explanation: "Which orders came back.",
        },
      ],
    },
  });
  expect(made.ok(), `the section is built: ${made.ok() ? "" : await made.text()}`).toBe(true);
  const { data: row } = await shop.admin
    .from("modules")
    .select("id")
    .eq("project_id", shop.projectId)
    .eq("name", "e2e-ticks")
    .single();
  const id = row!.id as string;
  try {
    await shop.admin.from("records").insert([
      { project_id: shop.projectId, module_id: id, data: { order_number: "T-1", rto: true, rto_note: "came back" } },
      { project_id: shop.projectId, module_id: id, data: { order_number: "T-2", rto: false } },
      { project_id: shop.projectId, module_id: id, data: { order_number: "T-3" } },
    ]);
    await page.goto(`/app/${shop.projectId}?section=${id}`);
    const rowOf = (n: string) => page.getByRole("row").filter({ hasText: n });
    await expect(rowOf("T-1")).toContainText("Yes", { timeout: 30_000 });
    // Unticked and never touched read the same: nothing, not "No".
    await expect(rowOf("T-2")).not.toContainText("No");
    await expect(rowOf("T-3")).not.toContainText("No");

    // The hidden note is not a column, and is there when the row opens.
    await expect(page.getByRole("columnheader", { name: "RTO note" })).toHaveCount(0);
    await rowOf("T-1").click();
    await expect(page.getByRole("dialog").getByText("came back")).toBeVisible();
    await page.keyboard.press("Escape");

    // Yes and No, and nothing the rows happen to hold (true, false).
    await page.getByRole("button", { name: "Filter by RTO" }).click();
    const options = page.getByRole("option");
    await expect(options).toHaveText(["Any rto", "Yes", "No"]);
    await page.getByRole("option", { name: "No" }).click();
    await expect(rowOf("T-2")).toBeVisible();
    await expect(rowOf("T-3")).toBeVisible();
    await expect(rowOf("T-1")).toHaveCount(0);
  } finally {
    await shop.admin.from("modules").delete().eq("id", id);
  }
});
