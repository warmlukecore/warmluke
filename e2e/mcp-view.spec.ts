// A design drawn inside the merchant's own AI (lib/design-view, MCP Apps).
//
// Claude and ChatGPT draw a page a server hands them beside a tool's
// answer, in a sealed frame that talks to them over postMessage. This
// stands in for that host, speaking the protocol as written (2026-01-26):
// the page asks to begin, is told the theme, says it is ready, is handed
// the tool's result, and says how tall it is. No app server is needed.
import { expect, test, type Page } from "@playwright/test";
import { designViewHtml } from "@/lib/design-view";

const design = {
  status: "waiting",
  request: "A packing screen for the courier desk",
  open: "https://warmluke.example/app/p?waiting=1",
  notCovered: ["a WhatsApp to the courier"],
  format: { locale: "en-IN", currency: "INR" },
  parts: [
    {
      title: "New section: Couriers",
      lines: ["Fields: Courier, Phone"],
      columns: [
        { field: "courier", label: "Courier", type: "text" },
        { field: "phone", label: "Phone", type: "text" },
      ],
      rows: [{ id: "a", data: { courier: "Delhivery", phone: "98000 00000" } }],
    },
    {
      title: "Change how Packing works",
      lines: [],
      columns: [{ field: "order_number", label: "Order", type: "text" }],
      rows: [{ id: "b", data: { order_number: "#1001", total: 1424 } }],
      screen: {
        title: "Desk",
        html: `<div class="wl-page"><div class="wl-banner info" id="b">Scan an order</div><p id="n"></p><p id="m"></p><button id="save">Save</button><p id="said"></p></div>
<script>
wl.onRows((rows) => { n.textContent = rows.length + " order"; m.textContent = wl.money(rows[0].data.total); });
save.onclick = async () => { try { await wl.set("b", { packed: true }); said.textContent = "saved"; } catch (e) { said.textContent = e.message; } };
</script>`,
      },
    },
  ],
};

/** A host, as Claude or ChatGPT is one: the frame, the handshake, the result handed over. */
async function host(page: Page, theme: "light" | "dark") {
  await page.setContent(`<!doctype html><html><body style="margin:0;background:${theme === "dark" ? "#111" : "#fff"}">
<iframe id="v" sandbox="allow-scripts" style="width:440px;height:900px;border:0"></iframe>
<script>
  const view = document.getElementById("v");
  window.said = [];
  addEventListener("message", (e) => {
    const m = e.data || {};
    window.said.push(m.method || "answer");
    const reply = (x) => view.contentWindow.postMessage(Object.assign({ jsonrpc: "2.0" }, x), "*");
    if (m.method === "ui/initialize") reply({ id: m.id, result: { protocolVersion: "2026-01-26", hostContext: { theme: "${theme}" } } });
    if (m.method === "ui/notifications/initialized") reply({ method: "ui/notifications/tool-result", params: { content: [], structuredContent: { design: window.design } } });
    if (m.method === "ui/open-link") { window.opened = m.params.url; reply({ id: m.id, result: {} }); }
  });
</script></body></html>`);
  await page.evaluate(
    ({ html, d }) => {
      (window as unknown as { design: unknown }).design = d;
      (document.getElementById("v") as HTMLIFrameElement).srcdoc = html;
    },
    { html: designViewHtml(), d: design }
  );
  return page.frameLocator("#v");
}

test("a design is drawn inside the merchant's own AI: each part, a screen run read-only, light and dark", async ({
  page,
  context,
}) => {
  const view = await host(page, "light");
  await expect(view.getByText("Waiting for your yes")).toBeVisible();
  await expect(view.getByText("A packing screen for the courier desk")).toBeVisible();
  // A part: its fields and a row of it.
  await expect(view.getByRole("columnheader", { name: "Courier" })).toBeVisible();
  await expect(view.getByText("Delhivery")).toBeVisible();
  // A written screen, run over the rows it was handed, in the store's money, saving nothing.
  await expect(view.locator("#n")).toHaveText("1 order");
  await expect(view.locator("#m")).toHaveText(/₹\s?1,424/);
  await view.getByRole("button", { name: "Save" }).click();
  await expect(view.locator("#said")).toHaveText("This is a preview: nothing is saved.");
  await expect(view.getByText("Not covered: a WhatsApp to the courier")).toBeVisible();
  // It spoke the protocol: began, said it was ready, said its size.
  const said = await page.evaluate(() => (window as unknown as { said: string[] }).said);
  expect(said).toEqual(
    expect.arrayContaining(["ui/initialize", "ui/notifications/initialized", "ui/notifications/size-changed"])
  );
  // And opens the design in Warmluke through the host, not by itself.
  await view.getByRole("button", { name: "Open in Warmluke" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { opened?: string }).opened)).toBe(design.open);

  // In the host's dark theme, the page is dark. A host of its own: a page's scripts share one scope.
  const dark = await host(await context.newPage(), "dark");
  await expect(dark.getByText("Waiting for your yes")).toBeVisible();
  const scheme = await dark.locator("body").evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  expect(scheme).toBe("dark");
});
