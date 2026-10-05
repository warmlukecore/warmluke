// A button that waits for the owner (0183, #6, 5 Oct), on the owner's
// screen: a teammate's press of Refund waits in the bell, under what waits
// on their yes, with the section and the row named; Approve does it, worked
// out from the row on the server, and the card goes. The press is made as a
// teammate's would be: a waiting row the database keeps (the server side,
// the teammate's own press and the hand edit refused, is check-row-approval-live).
import { expect, test } from "./shop";

test("a teammate's press waits in the owner's bell, and Approve does it", async ({ signedIn: page, shop }) => {
  const made = await page.request.post("/api/apply", {
    headers: { Authorization: `Bearer ${(shop.session as { access_token: string }).access_token}` },
    data: {
      projectId: shop.projectId,
      plans: [
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          newModule: { name: "e2e-appr-returns", nav_label: "Returns", icon: "table" },
          newSchema: {
            columns: [
              { field: "customer", label: "Customer", type: "text" },
              { field: "status", label: "Status", type: "badge" },
              { field: "amount", label: "Amount", type: "currency" },
            ],
          },
          features: {
            actions: [
              {
                label: "Refund",
                approval: true,
                set: { status: { const: "Refunded" } },
                when: { op: "=", args: [{ field: "status" }, { const: "Received" }] },
              },
            ],
          },
          newRecords: null,
          explanation: "Returns, refunded with the owner's yes.",
        },
      ],
    },
  });
  expect(made.ok(), "the section was built").toBe(true);
  const { data: mod } = await shop.admin
    .from("modules")
    .select("id")
    .eq("project_id", shop.projectId)
    .eq("name", "e2e-appr-returns")
    .single();
  const { data: rec } = await shop.admin
    .from("records")
    .insert({
      project_id: shop.projectId,
      module_id: mod!.id,
      data: { customer: "Asha Waiting", status: "Received", amount: 900 },
    })
    .select("id")
    .single();
  await shop.admin.from("row_approvals").insert({
    project_id: shop.projectId,
    module_id: mod!.id,
    record_id: rec!.id,
    action: "Refund",
    row_label: "Asha Waiting · Received",
    set: { status: "Refunded" },
    asked_by: shop.userId,
  });
  try {
    await page.goto(`/app/${shop.projectId}?section=${mod!.id}`);
    await expect(page.getByRole("cell", { name: "Asha Waiting" })).toBeVisible({ timeout: 30_000 });
    const phone = (page.viewportSize()?.width ?? 0) < 1024;
    if (phone) await page.getByRole("button", { name: /^Luke/ }).first().click();
    const panel = page.getByRole("complementary", { name: "Luke" });
    const bell = panel.getByRole("button", { name: /want your attention/ });
    await expect(bell).toBeVisible();
    await bell.click();
    await expect(panel.getByText("A TEAMMATE ASKS · RETURNS")).toBeVisible();
    await expect(panel.getByText("“Refund” on “Asha Waiting · Received”")).toBeVisible();
    await panel.getByRole("button", { name: "Approve" }).click();
    await expect(panel.getByText("A TEAMMATE ASKS · RETURNS")).toHaveCount(0);
    await expect
      .poll(async () => (await shop.admin.from("records").select("data").eq("id", rec!.id).single()).data?.data?.status)
      .toBe("Refunded");
    const { data: decided } = await shop.admin.from("row_approvals").select("status").eq("record_id", rec!.id).single();
    expect(decided!.status).toBe("approved");
  } finally {
    await shop.admin.from("modules").delete().eq("id", mod!.id);
  }
});
