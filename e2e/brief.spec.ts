// The day's brief (lib/brief), first on the Overview: a build whose check
// failed by name, the ones that passed counted, above the numbers, at both widths.
import { expect, test } from "./shop";

test("the Overview opens on the day's brief: what failed by name, what was built counted", async ({
  signedIn: page,
  shop,
}) => {
  const made: string[] = [];
  const build = async (title: string, ok: boolean) => {
    const { data } = await shop.admin
      .from("conversations")
      .insert({ project_id: shop.projectId, title, updated_at: new Date(Date.now() - 2 * 86_400_000).toISOString() })
      .select("id")
      .single();
    made.push(data!.id as string);
    await shop.admin.from("messages").insert({
      conversation_id: data!.id,
      role: "assistant",
      content: "Built 1 change.",
      payload: {
        type: "build",
        status: "built",
        message: "Built 1 change.",
        sent: [0],
        tested: { ok, said: "", problems: [] },
      },
    });
  };
  try {
    await build("Reorder list", false);
    await build("Returns board", true);
    await page.goto(`/app/${shop.projectId}`);
    const brief = page.locator("section").filter({ has: page.getByRole("heading", { name: "Today", exact: true }) });
    await expect(brief.getByText("Reorder list: built, and a check did not pass")).toBeVisible({ timeout: 30_000 });
    await expect(brief.getByText("Luke finished 1 build today, each tested on your data")).toBeVisible();
    // Above the numbers: what needs them comes first.
    const briefTop = (await brief.boundingBox())!.y;
    const kpiTop = (await page.getByText("Orders today").boundingBox())!.y;
    expect(briefTop).toBeLessThan(kpiTop);
    await brief.screenshot({ path: `${process.env.LOOK_DIR ?? "test-results"}/brief-${test.info().project.name}.png` });
  } finally {
    for (const id of made) await shop.admin.from("conversations").delete().eq("id", id);
  }
});
