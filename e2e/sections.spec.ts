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

    // Cmd or Ctrl is left to the browser, which opens a tab of its own.
    // Whether it does is the browser's: the headless one CI runs on
    // Linux opens none, so what is checked is that the app let it be,
    // and that the address opens the section in a tab of its own.
    const nav2 = await sidebar(page);
    const linked = nav2.getByRole("link", { name: "Linked" });
    await page.evaluate(() => {
      document.addEventListener(
        "click",
        (e) => {
          (window as unknown as { heldBack?: boolean }).heldBack = e.defaultPrevented;
          e.preventDefault();
        },
        { once: true }
      );
    });
    await linked.click({ modifiers: ["ControlOrMeta"] });
    expect(await page.evaluate(() => (window as unknown as { heldBack?: boolean }).heldBack)).toBe(false);
    const tab = await page.context().newPage();
    await tab.goto((await linked.getAttribute("href"))!);
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

// A value that reads as a code copies wherever it is drawn: the board,
// the cards and the list draw their fields through the same cell as
// the table, so one rule reaches every view. Copying never opens the row.
test("a code copies in every view — board, cards and list", async ({ signedIn: page, shop }) => {
  const headers = { Authorization: `Bearer ${(shop.session as { access_token: string }).access_token}` };
  const columns = [
    { field: "sku", label: "SKU", type: "text" },
    { field: "stage", label: "Stage", type: "dropdown", options: ["Packed", "Sent"] },
    { field: "note", label: "Note", type: "text" },
  ];
  const views = {
    board: { type: "board", groupBy: "stage", cardTitle: "note", cardFields: ["sku"] },
    cards: { type: "cards", titleField: "note", fields: ["sku"] },
    list: { type: "list", titleField: "note", secondaryField: "sku" },
  };
  const made = await page.request.post("/api/apply", {
    headers,
    data: {
      projectId: shop.projectId,
      plans: Object.entries(views).map(([kind, view]) => ({
        changeType: "NEW_MODULE",
        targetModuleId: null,
        newModule: { name: `e2e-code-${kind}`, nav_label: `Code ${kind}`, icon: "table" },
        newSchema: { columns, view },
        explanation: `Somewhere to see a code on a ${kind}.`,
      })),
    },
  });
  expect(made.ok(), "the three sections were built").toBe(true);
  const { data: rows } = await shop.admin
    .from("modules")
    .select("id, name")
    .eq("project_id", shop.projectId)
    .like("name", "e2e-code-%");
  const ids = (rows ?? []).map((r) => r.id as string);
  expect(ids).toHaveLength(3);
  try {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    for (const { id, name } of rows ?? []) {
      const put = await page.request.post("/api/records", {
        headers,
        data: {
          action: "create",
          projectId: shop.projectId,
          moduleId: id,
          data: { sku: "CF-0055-1", stage: "Packed", note: "Blue case" },
        },
      });
      expect(put.ok(), `a row went into ${name}`).toBe(true);
      await page.goto(`/app/${shop.projectId}?section=${id}`);
      await expect(page.getByText("Blue case")).toBeVisible();
      await page.getByRole("button", { name: "Copy CF-0055-1" }).click();
      await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
  } finally {
    for (const id of ids) await shop.admin.from("modules").delete().eq("id", id);
  }
});
