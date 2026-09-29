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

// The owner's own flow, as they said it: one input; the order's label
// first, which opens that order's lines alone; then each item in it;
// and once every line is done, back to the label for the next order,
// with no tap. Built straight from a design, no model in the way.
test("scan the order's label, then its items, and it moves on to the next order by itself", async ({
  signedIn: page,
  shop,
}) => {
  const headers = { Authorization: `Bearer ${(shop.session as { access_token: string }).access_token}` };
  const name = "e2e-pack-flow";
  const made = await page.request.post("/api/apply", {
    headers,
    data: {
      projectId: shop.projectId,
      plans: [
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          newModule: { name, nav_label: "Pack flow", icon: "table" },
          newSchema: {
            columns: [
              { field: "order_number", label: "Order", type: "text" },
              { field: "sku", label: "SKU", type: "text" },
              { field: "qty", label: "Qty", type: "number" },
              { field: "scanned", label: "Scanned", type: "number" },
            ],
          },
          features: {
            scanMode: {
              lookupField: "sku",
              first: { field: "order_number", label: "Scan the order label" },
              done: { op: ">=", args: [{ field: "scanned" }, { field: "qty" }] },
              action: {
                label: "Scan item",
                set: {
                  scanned: {
                    op: "if",
                    args: [
                      { op: "is_empty", args: [{ field: "scanned" }] },
                      { const: 1 },
                      { op: "+", args: [{ field: "scanned" }, { const: 1 }] },
                    ],
                  },
                },
              },
            },
          },
          explanation: "Order lines, packed by scanning the label and then the items.",
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
    for (const data of [
      { order_number: "#2001", sku: "CF-0001-1", qty: 1 },
      { order_number: "#2001", sku: "CF-0002-1", qty: 2 },
      { order_number: "#2002", sku: "CF-0003-1", qty: 1 },
    ]) {
      const put = await page.request.post("/api/records", {
        headers,
        data: { action: "create", projectId: shop.projectId, moduleId: id, data },
      });
      expect(put.ok(), "a line went in").toBe(true);
    }
    await page.goto(`/app/${shop.projectId}?section=${id}`);
    const bar = page.getByPlaceholder("Scan the label…");
    await expect(bar).toBeVisible();
    const scan = async (code: string) => {
      const input = page.getByPlaceholder(/Scan (the label|an item)…/);
      await input.fill(code);
      await input.press("Enter");
    };

    // The label opens that order alone.
    await scan("2001");
    await expect(page.getByText("Opened 2001: 2 lines. Scan the items.")).toBeVisible();
    await expect(page.getByText("2001 · 0 of 2 done")).toBeVisible();
    await expect(page.getByRole("cell", { name: "CF-0003-1" })).toHaveCount(0);

    // Its items, each unit a scan; the count is told as it goes.
    await scan("CF-0001-1");
    await expect(page.getByText("2001 · 1 of 2 done")).toBeVisible();
    await scan("cf-0002-1");
    await scan("CF-0002-1");

    // Every line done: said, and straight back to the label, no tap.
    await expect(page.getByText("2001 is done: every line checks out. Scan the next.")).toBeVisible();
    await expect(page.getByPlaceholder("Scan the label…")).toBeVisible();
    await expect(page.getByPlaceholder("Scan the label…")).toBeFocused();
    await scan("#2002");
    await expect(page.getByText("#2002 · 0 of 1 done")).toBeVisible();

    const { data: kept } = await shop.admin.from("records").select("data").eq("module_id", id);
    const scannedOf = (sku: string) => kept!.find((r) => r.data.sku === sku)?.data.scanned;
    expect([scannedOf("CF-0001-1"), scannedOf("CF-0002-1"), scannedOf("CF-0003-1") ?? null]).toEqual([1, 2, null]);
  } finally {
    await shop.admin.from("modules").delete().eq("id", id);
  }
});

// A screen written for the section runs sealed off: it draws the rows it
// is given, writes through window.wl like any button, finds rows by a
// code across the whole section, and reaches neither the network nor the
// app's own page. Built straight from a design, no model in the way.
test("a written screen draws the rows, writes through wl, and reaches nothing else", async ({
  signedIn: page,
  shop,
}) => {
  const headers = { Authorization: `Bearer ${(shop.session as { access_token: string }).access_token}` };
  const name = "e2e-station";
  const html = `<input id=scan placeholder=Scan><button id=asker>Ask</button><p id=answer></p><div id=list></div><p id=net>…</p><p id=app>…</p><button id=finder>Find 2001</button><p id=found></p>
<script>
// As station screens do: the scan box takes focus back whenever it loses it.
scan.addEventListener("blur", () => setTimeout(() => scan.focus(), 50));
scan.focus();
asker.onclick = async () => { answer.textContent = (await wl.ask("Reset it?", "Reset", "Keep")) ? "reset" : "kept"; };
wl.onRows((rows) => {
  list.innerHTML = "";
  for (const r of rows) {
    const b = document.createElement("button");
    b.textContent = (r.data.packed ? "Packed " : "Pack ") + r.data.sku;
    b.onclick = () => wl.set(r.id, { packed: true });
    list.append(b);
  }
});
window["fe" + "tch"]("/api/records").then(() => (net.textContent = "network reached"), () => (net.textContent = "network blocked"));
try { parent.document.title; app.textContent = "app reached"; } catch { app.textContent = "app sealed"; }
finder.onclick = async () => { const rows = await wl.find("order_number", "2001"); found.textContent = rows.length + " found"; };
</script>`;
  const made = await page.request.post("/api/apply", {
    headers,
    data: {
      projectId: shop.projectId,
      plans: [
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          newModule: { name, nav_label: "Station", icon: "table" },
          newSchema: {
            columns: [
              { field: "order_number", label: "Order", type: "text" },
              { field: "sku", label: "SKU", type: "text" },
              { field: "packed", label: "Packed", type: "boolean" },
            ],
          },
          features: { view: { type: "custom", title: "Station", html } },
          explanation: "A packing screen written for the section.",
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
    for (const data of [
      { order_number: "#2001", sku: "CF-0001-1" },
      { order_number: "#2001", sku: "CF-0002-1" },
      { order_number: "#2002", sku: "CF-0003-1" },
    ]) {
      const put = await page.request.post("/api/records", {
        headers,
        data: { action: "create", projectId: shop.projectId, moduleId: id, data },
      });
      expect(put.ok(), "a line went in").toBe(true);
    }
    await page.goto(`/app/${shop.projectId}?section=${id}`);
    const screen = page.frameLocator('iframe[title="Station"]');
    await expect(screen.getByRole("button", { name: "Pack CF-0001-1" })).toBeVisible();

    // It wears the app's face, handed in: the built app's CSS names its font
    // files relative to itself, and a path read against the page found none.
    await expect
      .poll(() =>
        screen
          .locator("body")
          .evaluate(() =>
            [...document.fonts].some((f) => f.family.replace(/"/g, "") === "WL Sans" && f.status === "loaded")
          )
      )
      .toBe(true);

    // A screen may keep its scan box focused, but not take focus back from
    // the page: with it pulled back, nothing in Luke's panel could be copied.
    await screen.locator("#scan").click();
    await page.locator("h1").first().click();
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => document.activeElement?.tagName), "focus stays on the page").not.toBe("IFRAME");
    // And the moment the owner is back on the screen, the box has it again.
    await screen.locator("#net").click();
    await expect.poll(() => screen.locator("#scan").evaluate((el) => document.activeElement === el)).toBe(true);

    // A question, in the app's dialog: the browser's own are blocked in the
    // frame. A scanner's Enter does not answer it; a tap does.
    await screen.getByRole("button", { name: "Ask", exact: true }).click();
    await expect(screen.getByRole("dialog")).toContainText("Reset it?");
    await page.keyboard.press("Enter");
    await expect(screen.getByRole("dialog"), "an Enter from outside it answers nothing").toBeVisible();
    await screen.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(screen.locator("#answer")).toHaveText("reset");
    await expect(screen.getByRole("dialog")).toHaveCount(0);

    // Sealed: no network, no reach into the app's page.
    await expect(screen.getByText("network blocked")).toBeVisible();
    await expect(screen.getByText("app sealed")).toBeVisible();

    // It writes the way a button does, and the new row comes back to it.
    await screen.getByRole("button", { name: "Pack CF-0001-1" }).click();
    await expect(screen.getByRole("button", { name: "Packed CF-0001-1" })).toBeVisible();
    const { data: kept } = await shop.admin.from("records").select("data").eq("module_id", id);
    expect(kept!.find((r) => r.data.sku === "CF-0001-1")?.data.packed).toBe(true);

    // And finds by a code across the whole section, "#" or not.
    await screen.getByRole("button", { name: "Find 2001" }).click();
    await expect(screen.getByText("2 found")).toBeVisible();
  } finally {
    await shop.admin.from("modules").delete().eq("id", id);
  }
});
