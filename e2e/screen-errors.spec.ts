// A written screen that breaks says so under itself, offers to hand it to
// Luke, and is kept for the console's Needs a look (0178). Before, a
// screen whose read failed showed a red line of its own and nobody heard
// of it (Tanish, 4 Oct).
import { expect, test } from "./shop";

test("a written screen that breaks says so, offers Luke, and is kept", async ({ signedIn: page, shop }) => {
  const auth = { Authorization: `Bearer ${(shop.session as { access_token: string }).access_token}` };
  // As Tanish's screen did: it catches its own failed read and shows a line of its own.
  const screen = `<div class="wl-page"><h2>Desk</h2><p id="m"></p></div><script>wl.read("#nowhere").catch(() => { document.getElementById("m").textContent = "Could not load."; });</script>`;
  const made = await page.request.post("/api/apply", {
    headers: auth,
    data: {
      projectId: shop.projectId,
      plans: [
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          newModule: { name: "e2e-broken-screen", nav_label: "Desk", icon: "table" },
          newSchema: { columns: [{ field: "note", label: "Note", type: "text" }] },
          features: { view: { type: "custom", title: "Desk", html: screen } },
          explanation: "A screen that reads a section that is not there.",
        },
      ],
    },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const { data: mod } = await shop.admin
    .from("modules")
    .select("id")
    .eq("project_id", shop.projectId)
    .eq("name", "e2e-broken-screen")
    .single();
  try {
    await page.goto(`/app/${shop.projectId}?section=${mod!.id}`);
    const told = page.getByRole("status").filter({ hasText: "This screen ran into a problem" });
    await expect(told).toBeVisible({ timeout: 30_000 });
    await expect(told).toContainText("#nowhere");
    await expect(told.getByRole("button", { name: "Ask Luke to fix it" })).toBeVisible();
    await expect
      .poll(
        async () => (await shop.admin.from("screen_errors").select("id").eq("module_id", mod!.id)).data?.length ?? 0
      )
      .toBe(1);
  } finally {
    await shop.admin.from("modules").delete().eq("id", mod!.id);
  }
});
