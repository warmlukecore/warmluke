// The tryout's browser walk (lib/walk.ts, 5 Oct): the walk page draws a
// section with the app's own components, sealed (scripts/build-walk-page),
// and the walker uses it as a person would. A section that works goes
// through, a filter with nothing to choose and a written screen that
// breaks are caught; and what the walk found on a build is said under it
// in the thread, with a way to ask Luke to fix it.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./shop";
import { walk } from "../src/walk/walker.mjs";

const is = (field: string, value: string) => ({ op: "=", args: [{ field }, { const: value }] });
const returns = (reasons: string[], tabs: unknown[] = []) => ({
  schema: {
    columns: [
      { field: "order", label: "Order", type: "link", linkTo: "m-orders" },
      { field: "customer_name", label: "Customer", type: "text" },
      { field: "reason", label: "Reason", type: "dropdown" },
      { field: "status", label: "Status", type: "badge" },
      { field: "amount", label: "Amount", type: "currency" },
    ],
    features: {
      filters: [
        { field: "reason", label: "Reason", options: reasons },
        { field: "status", label: "Status", options: ["Requested", "Received"] },
      ],
      actions: [{ label: "Received", set: { status: { const: "Received" } }, when: is("status", "Requested") }],
      stats: [{ label: "Waiting", op: "count", where: is("status", "Requested") }],
      ...(tabs.length ? { tabs } : {}),
    },
  },
  rows: [
    {
      id: "r1",
      data: { order: "o1", customer_name: "Asha", reason: reasons[0] ?? "", status: "Requested", amount: 900 },
    },
    {
      id: "r2",
      data: { order: "o2", customer_name: "Ravi", reason: reasons[1] ?? "", status: "Received", amount: 1200 },
    },
  ],
  links: {
    "m-orders": [
      { id: "o1", label: "#1042", data: { order_number: "#1042", customer_name: "Asha" } },
      { id: "o2", label: "#1043", data: { order_number: "#1043", customer_name: "Ravi" } },
    ],
  },
  targets: {
    "m-orders": {
      table: "orders",
      parents: {},
      columns: [
        { field: "order_number", label: "Order", type: "text" },
        { field: "customer_name", label: "Customer", type: "text" },
      ],
    },
  },
  locale: "en-IN",
  currency: "INR",
  timeZone: "Asia/Kolkata",
});
// The input as lib/walk.ts's walkPage puts it in: "<" escaped, so a written screen's own </script> cannot end the page's.
const open = async (page: Page, input: unknown) =>
  page.setContent(
    readFileSync(".walk/walk.html", "utf8").replace("/*WL_WALK*/null", JSON.stringify(input).replaceAll("<", "\\u003c"))
  );
const broke = (r: { steps: Array<{ what: string; ok: boolean; why?: string }> }) =>
  r.steps.filter((s) => !s.ok).map((s) => `${s.what}: ${s.why}`);

test("a section that works is walked through: filters, sort, a row's button, the form", async ({ page }) => {
  await open(page, returns(["Size", "Damaged"]));
  const r = await walk(page);
  expect(r.steps.map((s: { what: string }) => s.what)).toEqual(
    expect.arrayContaining([
      "The section opens",
      "Filter by Reason",
      "Filter by Status",
      "Sorting by each column",
      "The Received button",
      "Adding a row with the form",
    ])
  );
  expect(broke(r)).toEqual([]);
  expect(r.errors).toEqual([]);
});

test("a filter with nothing to choose, and a written screen that breaks, are caught", async ({ page }) => {
  const screen = {
    type: "custom",
    title: "Packing",
    html: "<div class='wl-page'>Packing</div><script>wl.onRows(() => { throw new Error('rows is not iterable') })</script>",
  };
  await open(page, returns([], [screen]));
  const r = await walk(page);
  expect(broke(r)).toEqual(expect.arrayContaining(["Filter by Reason: it offers nothing to choose"]));
  expect(broke(r).some((b) => /Packing/.test(b))).toBe(true);
});

test("what the walk found on a build is said under it, with a way to fix it", async ({ signedIn: page, shop }) => {
  const { data: thread } = await shop.admin
    .from("conversations")
    .insert({ project_id: shop.projectId, title: "Returns" })
    .select("id")
    .single();
  const t = Date.now();
  await shop.admin.from("messages").insert([
    {
      conversation_id: thread!.id,
      role: "user",
      content: "returns log chahiye",
      payload: { kind: "user", text: "returns log chahiye" },
      created_at: new Date(t).toISOString(),
    },
    {
      conversation_id: thread!.id,
      role: "assistant",
      content: "Returns.",
      payload: {
        type: "build",
        status: "built",
        message: "Returns.",
        started_at: new Date(t).toISOString(),
        walked: [{ name: "Returns", tried: 12, breaks: ["Filter by Reason: it offers nothing to choose"] }],
      },
      created_at: new Date(t + 1).toISOString(),
    },
  ]);
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/chat") && r.method() === "POST");
  await page.route("**/api/chat", (route) => (route.request().method() === "POST" ? route.abort() : route.fallback()));
  try {
    await page.goto(`/app/${shop.projectId}?c=${thread!.id}`);
    if ((page.viewportSize()?.width ?? 0) < 1024) await page.getByRole("button", { name: /^Luke/ }).first().click();
    const panel = page.getByRole("complementary", { name: "Luke" });
    await expect(panel.getByText("Tried in a browser: 1 of 12 did not work")).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText(/^Returns: Filter by Reason: it offers nothing to choose/)).toBeVisible();
    await panel.getByRole("button", { name: "Fix it" }).click();
    const asked = ((await sent).postDataJSON() as { message?: string }).message;
    expect(asked).toBe(
      [
        "After the last build, Returns was tried in a browser, on a laptop and a phone, as the team would use it, and this did not work:",
        "- Filter by Reason: it offers nothing to choose",
        "Fix Returns so it works as they would expect. Change only what has to change.",
      ].join("\n")
    );
    await expect(panel.getByText("Asking Luke to fix it…")).toBeVisible();
  } finally {
    await shop.admin.from("conversations").delete().eq("id", thread!.id);
  }
});
