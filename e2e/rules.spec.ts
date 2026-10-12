// The Rules dialog says what each rule did (0206): how often it ran, what its
// last run changed, and when a list it read was longer than one run is
// handed. Tanish's sync ran on every save and changed nothing, and the
// dialog said "Hasn't run yet" (11 Oct). Runs are written as the rules
// themselves keep them; whether they are kept is check-rule-log's.
import { expect, test } from "./shop";

test("each rule says how often it ran, what its last run changed, and a read cut short", async ({
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
          newModule: { name: "e2e-blanks", nav_label: "Blanks", icon: "table" },
          newSchema: {
            columns: [
              { field: "parent_sku", label: "Parent SKU", type: "text" },
              { field: "total_available", label: "Total available", type: "number" },
            ],
          },
          explanation: "Blank stock.",
        },
      ],
    },
  });
  expect(made.ok(), `the section is built: ${made.ok() ? "" : await made.text()}`).toBe(true);
  const { data: mod } = await shop.admin
    .from("modules")
    .select("id")
    .eq("project_id", shop.projectId)
    .eq("name", "e2e-blanks")
    .single();
  const id = mod!.id as string;
  try {
    const code = "export default function run() { return { set: [] }; }";
    const { data: rules } = await shop.admin
      .from("automations")
      .insert([
        {
          project_id: shop.projectId,
          module_id: id,
          name: "Sync blank stock",
          definition: { trigger: { type: "record_updated" }, actions: [{ type: "run_code", code }] },
        },
        {
          project_id: shop.projectId,
          module_id: id,
          name: "Tag new blanks",
          definition: { trigger: { type: "record_created" }, actions: [{ type: "run_code", code }] },
        },
      ])
      .select("id, name");
    const sync = rules!.find((r) => r.name === "Sync blank stock")!.id;
    const tag = rules!.find((r) => r.name === "Tag new blanks")!.id;
    // Every row says when: a list of rows is written with one set of columns, a missing one as null.
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const { error } = await shop.admin.from("automation_runs").insert([
      { automation_id: sync, ok: true, detail: { kind: "code", wrote: 34 }, created_at: ago(60) },
      {
        automation_id: sync,
        ok: true,
        detail: { kind: "code", wrote: 0, read: { Stock: { rows: 50000, cut: true } } },
        created_at: ago(1),
      },
      { automation_id: tag, ok: true, detail: { kind: "code", wrote: 34 }, created_at: ago(1) },
    ]);
    expect(error, error?.message).toBeNull();

    await page.goto(`/app/${shop.projectId}?section=${id}`);
    await page.getByRole("button", { name: "Rules" }).click();
    const dialog = page.getByRole("dialog", { name: "Rules" });
    const card = (name: string) => dialog.locator("div.rounded-card").filter({ hasText: name });
    await expect(card("Tag new blanks")).toContainText(/Ran 1 time · last .* · changed 34 rows · no errors/, {
      timeout: 30_000,
    });
    await expect(card("Sync blank stock")).toContainText(/Ran 2 times · last .* · changed no rows/);
    await expect(card("Sync blank stock")).toContainText("read only part of a list");
    await expect(card("Tag new blanks")).not.toContainText("read only part of a list");
    await page.screenshot({ path: `${process.env.LOOK_DIR ?? "test-results"}/rules-${test.info().project.name}.png` });
  } finally {
    await shop.admin.from("modules").delete().eq("id", id);
  }
});
