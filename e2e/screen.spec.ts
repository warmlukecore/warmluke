// Luke working on the screen that is open (lib/screen.ts, #3, 5 Oct). An
// answer that narrows the section does it on screen as it is said, and
// says so under it in the code's words; one that fills a row opens the
// form filled, the order found from its number and the rest filled from
// it, and nothing is saved until Add row. A link from their own AI
// (show_on_screen) opens the section the same way, read again as it
// opens, and leaves the address. The reply stands in for the model's: what
// is checked here is the screen, not what a model says (check-screen).
import type { Locator, Page } from "@playwright/test";
import { LUKE_COPY } from "@/lib/luke-copy";
import { screenHref } from "@/lib/screen";
import { expect, test } from "./shop";

type Shop = Parameters<Parameters<typeof test>[2]>[0]["shop"];

const phone = (page: Page) => (page.viewportSize()?.width ?? 0) < 1024;

/** On the screen: inside the window, not only drawn somewhere off it. */
const onScreen = (l: Locator) =>
  l.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight;
  });

/** A returns section over the shop's orders, with two returns in it. */
async function returnsSection(page: Page, shop: Shop) {
  const made = await page.request.post("/api/apply", {
    headers: { Authorization: `Bearer ${(shop.session as { access_token: string }).access_token}` },
    data: {
      projectId: shop.projectId,
      plans: [
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          newModule: { name: "e2e-scr-orders", nav_label: "Orders", icon: "shopping-cart", source_table: "orders" },
          newSchema: null,
          newRecords: null,
          explanation: "The store's orders.",
        },
        {
          changeType: "NEW_MODULE",
          targetModuleId: null,
          newModule: { name: "e2e-scr-returns", nav_label: "Returns", icon: "table" },
          newSchema: {
            columns: [
              { field: "order", label: "Order", type: "link", linkTo: "#e2e-scr-orders" },
              { field: "customer_name", label: "Customer", type: "text" },
              { field: "reason", label: "Reason", type: "dropdown" },
              { field: "status", label: "Status", type: "badge" },
            ],
          },
          features: {
            filters: [
              { field: "status", label: "Status", options: ["Requested", "Received"] },
              { field: "reason", label: "Reason", options: ["Size", "Damaged"] },
            ],
          },
          newRecords: null,
          explanation: "Returns against an order.",
        },
      ],
    },
  });
  expect(made.ok(), "the sections were built").toBe(true);
  const { data: mods } = await shop.admin.from("modules").select("id, name").eq("project_id", shop.projectId);
  const returns = mods!.find((m) => m.name === "e2e-scr-returns")!.id as string;
  await shop.admin.from("records").insert([
    {
      project_id: shop.projectId,
      module_id: returns,
      data: { customer_name: "Asha Waiting", reason: "Size", status: "Requested" },
    },
    {
      project_id: shop.projectId,
      module_id: returns,
      data: { customer_name: "Ravi Back", reason: "Damaged", status: "Received" },
    },
  ]);
  const remove = () =>
    shop.admin
      .from("modules")
      .delete()
      .in(
        "id",
        mods!.filter((m) => m.name.startsWith("e2e-scr-")).map((m) => m.id)
      );
  return { returns, remove };
}

/** Luke's next answer, as the server would send it. */
const answers = async (page: Page, reply: Record<string, unknown>) => {
  await page.unroute("**/api/chat");
  await page.route("**/api/chat", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ json: { reply: { type: "answer", kind: "conversation", ...reply } } })
      : route.fallback()
  );
};

test("Luke narrows the section on screen and fills a row, saved only on Add row", async ({ signedIn: page, shop }) => {
  const { returns, remove } = await returnsSection(page, shop);
  const { data: someOrder } = await shop.admin
    .from("store_orders")
    .select("id, order_number, customer_name")
    .eq("store_id", shop.storeId)
    .not("customer_name", "is", null)
    .limit(1)
    .single();
  try {
    await page.goto(`/app/${shop.projectId}?section=${returns}`);
    await expect(page.getByRole("cell", { name: "Ravi Back" })).toBeVisible({ timeout: 30_000 });
    const panel = page.getByRole("complementary", { name: "Luke" });
    const box = panel.getByPlaceholder(LUKE_COPY.placeholder);
    const openLuke = async () => {
      // Shut, the drawer is off the screen, not hidden: on screen is what says it is open.
      if (phone(page) && !(await onScreen(box))) await page.getByRole("button", { name: /^Luke/ }).first().click();
      await expect(box).toBeInViewport();
    };
    await openLuke();
    const fresh = panel.getByRole("button", { name: "New conversation" });
    if (await fresh.count()) await fresh.click();

    // Narrowed as it is said, and said under it in the code's words.
    await answers(page, {
      message: "Showing the returns still waiting.",
      show: { moduleId: returns, filters: { status: "Requested" }, said: "Returns: Status: Requested" },
    });
    await box.fill("sirf waiting wale dikhao");
    await box.press("Enter");
    await expect(page.getByRole("cell", { name: "Ravi Back" })).toHaveCount(0);
    await expect(page.getByRole("cell", { name: "Asha Waiting" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Filter by Status: Requested/ })).toBeVisible();
    // On a phone the panel stood aside, so what was done is seen.
    if (phone(page)) await expect(box).not.toBeInViewport();
    await openLuke();
    await expect(panel.getByText("On your screen: Returns: Status: Requested")).toBeVisible();

    // Moved by hand, set again from the line.
    if (phone(page)) await panel.getByRole("button", { name: "Close Luke" }).click();
    await page.getByRole("button", { name: /^Filter by Status/ }).click();
    await page.getByRole("option").first().click();
    await expect(page.getByRole("cell", { name: "Ravi Back" })).toBeVisible();
    await openLuke();
    await panel.getByRole("button", { name: "Show again" }).click();
    await expect(page.getByRole("cell", { name: "Ravi Back" })).toHaveCount(0);

    // A row given to put in: the form opens filled, the order found by its number.
    await openLuke();
    await answers(page, {
      message: "Filled the return in: check it and press Add row.",
      show: {
        moduleId: returns,
        add: { order: someOrder!.order_number, customer_name: "Neha Fill", reason: "Damaged" },
        said: "a new row in Returns, Order, Customer, Reason filled",
      },
    });
    await box.fill(`Neha ka return, order ${someOrder!.order_number}, damaged aaya`);
    await box.press("Enter");
    const form = page.getByRole("dialog");
    await expect(form.getByText("Filled in for you")).toBeVisible();
    await expect(form.getByRole("textbox", { name: "Customer" })).toHaveValue("Neha Fill");
    await expect(
      form.getByRole("button", { name: new RegExp(`^Order: .*${someOrder!.order_number.replace("#", "")}`) })
    ).toBeVisible();
    await expect(form.getByRole("button", { name: /^Reason: Damaged/ })).toBeVisible();
    const saved = async () =>
      ((await shop.admin.from("records").select("data").eq("module_id", returns)).data ?? []).map(
        (r) => (r.data as Record<string, unknown>).customer_name
      );
    expect(await saved(), "nothing saved before Add row").not.toContain("Neha Fill");
    await form.getByRole("button", { name: "Add row" }).click();
    await expect(form).toHaveCount(0);
    await expect.poll(saved).toContain("Neha Fill");
    const { data: row } = await shop.admin
      .from("records")
      .select("data")
      .eq("module_id", returns)
      .eq("data->>customer_name", "Neha Fill")
      .single();
    expect((row!.data as Record<string, unknown>).order, "the order picked, not its words").toBe(someOrder!.id);
  } finally {
    await page.unroute("**/api/chat");
    await remove();
  }
});

test("a link from their own AI opens the section that way, read again as it opens", async ({
  signedIn: page,
  shop,
}) => {
  const { returns, remove } = await returnsSection(page, shop);
  try {
    await page.goto(screenHref(shop.projectId, { moduleId: returns, filters: { status: "Received" } }));
    await expect(page.getByRole("cell", { name: "Ravi Back" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("cell", { name: "Asha Waiting" })).toHaveCount(0);
    // Done once: the address no longer carries it, so a refresh is the section as they left it.
    await expect.poll(() => new URL(page.url()).searchParams.get("show")).toBeNull();
    expect(new URL(page.url()).searchParams.get("section")).toBe(returns);

    // A link is anyone's words: what the section does not offer is not done.
    await page.goto(
      `/app/${shop.projectId}?section=${returns}&show=${encodeURIComponent(JSON.stringify({ filters: { status: "Lost" } }))}`
    );
    await expect(page.getByRole("cell", { name: "Ravi Back" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("cell", { name: "Asha Waiting" })).toBeVisible();
  } finally {
    await remove();
  }
});
