// A column that reads another row (0219): a design shows its blank's
// count, read through its link, and a blank counts and adds up the
// designs on it, worked out each time, never copied by a rule. The
// table and its counters agree with the rows, at both widths.
import { expect, test } from "./shop";

const lookup = (link: string, field: string, at: string) => ({
  op: "lookup",
  args: [{ field: link }, { const: field }, { const: at }],
});
const rollup = (...a: string[]) => ({ op: "rollup", args: a.map((x) => ({ const: x })) });

test("a design shows its blank's count, and a blank counts the designs on it", async ({ signedIn: page, shop }) => {
  const stamp = Date.now();
  const made: string[] = [];
  const section = async (name: string, label: string, columns: unknown[], features: unknown = {}) => {
    const { data: mod } = await shop.admin
      .from("modules")
      .insert({
        project_id: shop.projectId,
        name: `${name}-${stamp}`,
        nav_label: label,
        icon: "table",
        route: `/modules/${name}-${stamp}`,
        sort_order: 90,
      })
      .select("id")
      .single();
    made.push(mod!.id);
    await shop.admin.from("ui_schemas").insert({
      module_id: mod!.id,
      schema_json: { columns, features },
      version: 1,
      created_by: "user",
      change_description: "e2e",
    });
    return mod!.id as string;
  };
  const rows = async (moduleId: string, list: Record<string, unknown>[]) =>
    (
      await shop.admin
        .from("records")
        .insert(list.map((data) => ({ module_id: moduleId, data })))
        .select("id")
    ).data!.map((r) => r.id as string);
  try {
    const blankCols = [
      { field: "sku", label: "SKU", type: "text" },
      { field: "count", label: "Count", type: "number" },
    ];
    const blanks = await section("e2e-blanks", "Blanks", blankCols);
    const designs = await section("e2e-designs", "Designs", [
      { field: "name", label: "Name", type: "text" },
      { field: "blank", label: "Blank", type: "link", linkTo: blanks },
      { field: "printed", label: "Printed", type: "number" },
      { field: "blank_count", label: "Blank stock", type: "number", compute: lookup("blank", "count", blanks) },
    ]);
    // The blank's own side, once the designs exist to point at it.
    await shop.admin.from("ui_schemas").insert({
      module_id: blanks,
      schema_json: {
        columns: [
          ...blankCols,
          { field: "on_it", label: "Designs on it", type: "number", compute: rollup(designs, "blank", "count") },
          { field: "printed", label: "Printed", type: "number", compute: rollup(designs, "blank", "sum", "printed") },
        ],
        features: { stats: [{ label: "Designs placed", op: "sum", value: { field: "on_it" } }] },
      },
      version: 2,
      created_by: "user",
      change_description: "e2e",
    });
    const [b1, b2] = await rows(blanks, [
      { sku: "POX-17PM-SL", count: 200 },
      { sku: "POX-16-BK", count: 40 },
    ]);
    await rows(designs, [
      { name: "Cherry Heart", blank: b1, printed: 2 },
      { name: "Mad Max", blank: b1, printed: 3 },
      { name: "Soda", blank: b2, printed: 1 },
    ]);

    // A design reads its blank's count through the link.
    await page.goto(`/app/${shop.projectId}?section=${designs}`);
    await expect(page.getByRole("heading", { level: 1, name: "Designs" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("row", { name: /Cherry Heart/ })).toContainText("200");
    await expect(page.getByRole("row", { name: /Soda/ })).toContainText("40");

    // A blank counts the designs on it and adds up what they printed; its counter counts every row.
    await page.goto(`/app/${shop.projectId}?section=${blanks}`);
    await expect(page.getByRole("heading", { level: 1, name: "Blanks" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("row", { name: /POX-17PM-SL/ })).toContainText(/200\s*2\s*5/);
    await expect(page.getByRole("row", { name: /POX-16-BK/ })).toContainText(/40\s*1\s*1/);
    // Counted on the server over every row, rollups and all: 2 + 1.
    await expect(page.getByRole("status", { name: "Counting Designs placed" })).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText("Designs placed", { exact: true }).locator("xpath=../..")).toContainText("3");
    await page.screenshot({
      path: `${process.env.LOOK_DIR ?? "test-results"}/lookup-rollup-${test.info().project.name}.png`,
    });
  } finally {
    for (const id of made) await shop.admin.from("modules").delete().eq("id", id);
  }
});
