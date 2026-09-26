// A section has an address. The sidebar's rows were buttons over state
// the shell alone held: right-click offered no new tab, Cmd/Ctrl-click
// did nothing, a refresh went back to the start, and back left the app.
// They are links now (?section=…), opened in place by a plain click.
import type { Page } from "@playwright/test";
import { expect, test } from "./shop";

/** The sidebar, opened where it is a drawer. */
async function sidebar(page: Page) {
  if ((page.viewportSize()?.width ?? 0) < 1024) await page.getByRole("button", { name: "Open sections" }).click();
  return page.getByRole("navigation");
}

test("a section in the sidebar is a link: its own address, a new tab, a refresh, and back", async ({
  signedIn: page,
  shop,
}) => {
  const name = "e2e-linked";
  const made = await page.request.post("/api/apply", {
    headers: { Authorization: `Bearer ${(shop.session as { access_token: string }).access_token}` },
    data: {
      projectId: shop.projectId,
      plans: [
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          newModule: { name, nav_label: "Linked", icon: "table" },
          newSchema: { columns: [{ field: "note", label: "Note", type: "text" }], view: { type: "table" } },
          explanation: "Somewhere to keep links.",
        },
      ],
    },
  });
  expect(made.ok(), "the section was built").toBe(true);
  const { data: row } = await shop.admin
    .from("modules")
    .select("id")
    .eq("project_id", shop.projectId)
    .eq("name", name)
    .single();
  const id = row!.id as string;
  try {
    await page.goto(`/app/${shop.projectId}`);
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
    const nav = await sidebar(page);
    const link = nav.getByRole("link", { name: "Linked" });
    // Right-click and "Open in new tab" work on anything with an address.
    await expect(link).toHaveAttribute("href", `/app/${shop.projectId}?section=${id}`);

    // A plain click opens it here, without loading the page again.
    await link.click();
    await expect(page.getByRole("heading", { level: 1, name: "Linked" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`\\?section=${id}$`));

    // A refresh keeps it open.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Linked" })).toBeVisible();

    // Cmd or Ctrl opens it in a tab of its own.
    const nav2 = await sidebar(page);
    const [tab] = await Promise.all([
      page.context().waitForEvent("page"),
      nav2.getByRole("link", { name: "Linked" }).click({ modifiers: ["ControlOrMeta"] }),
    ]);
    await tab.waitForLoadState();
    await expect(tab).toHaveURL(new RegExp(`\\?section=${id}$`));
    await expect(tab.getByRole("heading", { level: 1, name: "Linked" })).toBeVisible();
    await tab.close();

    // Back goes to where they were, not out of the app.
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/app/${shop.projectId}$`));

    // An address naming a section that is not there opens the start.
    await page.goto(`/app/${shop.projectId}?section=00000000-0000-4000-8000-000000000000`);
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/app/${shop.projectId}$`));
  } finally {
    await shop.admin.from("modules").delete().eq("id", id);
  }
});
