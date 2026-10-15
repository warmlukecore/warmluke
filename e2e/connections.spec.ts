// Settings → Connections (0204, docs/integrations/connectors.md): every
// connector, where it stands, and the owner's connect and disconnect, in
// place. Shiprocket is stood in for: the route that proves a login with
// it is answered here, and what it would keep is written as it would be.
// Who may connect, and what a ticket reaches, is check-connectors'.
import { expect, test } from "./shop";

test("the owner connects a courier in Settings, sees where it stands, and disconnects it", async ({
  signedIn: page,
  shop,
}) => {
  const added: string[] = [];
  await page.route("**/api/connectors", async (route) => {
    const req = route.request();
    const body = req.postDataJSON() as { provider?: string; fields?: Record<string, string>; connectionId?: string };
    if (req.method() === "POST") {
      if (body.fields?.password === "wrong") {
        return route.fulfill({ status: 400, json: { error: "These credentials do not match our records." } });
      }
      const { data } = await shop.admin
        .from("store_connections")
        .upsert(
          {
            project_id: shop.projectId,
            store_id: shop.storeId,
            provider: "shiprocket",
            account_ref: body.fields?.email ?? "api@shop.in",
            account_label: body.fields?.email,
            status: "connected",
            connected_by: shop.userId,
          },
          { onConflict: "store_id,provider,account_ref" }
        )
        .select("id")
        .single();
      added.push(data!.id);
      return route.fulfill({ json: { id: data!.id } });
    }
    if (req.method() === "DELETE") {
      await shop.admin
        .from("store_connections")
        .update({ status: "disconnected", disconnected_at: new Date().toISOString() })
        .eq("id", body.connectionId!);
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { ok: true, said: "not_configured" } });
  });

  try {
    await page.goto(`/app/${shop.projectId}`);
    await expect(page.getByRole("img", { name: /Orders per day/ })).toBeVisible({ timeout: 30_000 });
    if ((page.viewportSize()?.width ?? 0) < 1024) await page.getByRole("button", { name: "Open sections" }).click();
    await page.getByRole("button", { name: "Project settings" }).click();
    await page.getByRole("tab", { name: "Connections" }).click();
    const dialog = page.getByRole("dialog");

    // Every connector, and what the ones not ready wait for.
    await expect(dialog.getByText("Couriers", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Shiprocket", { exact: true })).toBeVisible();
    await expect(dialog.getByText("GoSwift", { exact: true })).toBeVisible();
    // Every kind has its group, and every provider its own mark (0215).
    for (const group of ["Ads", "Analytics", "Email", "Messaging", "Payments", "Support", "CRM", "Social"]) {
      await expect(dialog.getByText(group, { exact: true })).toBeVisible();
    }
    for (const name of [
      "Delhivery",
      "Google Ads",
      "Google Analytics",
      "Mailchimp",
      "Brevo",
      "Klaviyo",
      "WhatsApp Business",
      "Razorpay",
      "Zendesk",
      "HubSpot",
      "Facebook & Instagram",
    ]) {
      const item = dialog.getByRole("listitem").filter({ hasText: name });
      await expect(item.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
      await expect(item.locator("img")).toHaveJSProperty("complete", true);
      expect(await item.locator("img").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
    }

    // Nothing in the list is wider than the dialog: its body never scrolls sideways.
    const sideways = await dialog.evaluate((d) => {
      const body = [...d.querySelectorAll<HTMLElement>("*")].find(
        (n) => /(auto|scroll)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight
      );
      return body ? body.scrollWidth - body.clientWidth : 0;
    });
    expect(sideways).toBeLessThanOrEqual(1);

    // Each group as it looks, for a person to read (LOOK_DIR).
    for (const group of [
      "Couriers",
      "Ads",
      "Analytics",
      "Email",
      "Messaging",
      "Payments",
      "Support",
      "CRM",
      "Social",
    ]) {
      const section = dialog
        .locator("section")
        .filter({ has: page.getByText(group, { exact: true }) })
        .first();
      await section.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `${process.env.LOOK_DIR ?? "test-results"}/connections-${group.toLowerCase()}-${test.info().project.name}.png`,
      });
    }

    // Google Analytics takes the key file whole; Google Ads' manager account may be left empty.
    const ga = dialog.getByRole("listitem").filter({ hasText: "Google Analytics" });
    await ga.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(ga.locator("textarea")).toBeVisible();
    await ga.getByLabel("Property ID").fill("123456789");
    await ga.locator("textarea").fill('{"client_email":"wl@x.iam.gserviceaccount.com"}');
    await expect(ga.getByRole("button", { name: "Connect Google Analytics" })).toBeEnabled();
    await ga.screenshot({
      path: `${process.env.LOOK_DIR ?? "test-results"}/connections-ga-${test.info().project.name}.png`,
    });
    await ga.getByRole("button", { name: "Cancel" }).click();
    const gads = dialog.getByRole("listitem").filter({ hasText: "Google Ads" });
    await gads.getByRole("button", { name: "Connect", exact: true }).click();
    for (const label of [
      "Ad account ID",
      "Developer token",
      "OAuth client ID",
      "OAuth client secret",
      "Refresh token",
    ]) {
      await gads.getByLabel(label, { exact: true }).fill("x");
    }
    await expect(gads.getByRole("button", { name: "Connect Google Ads" })).toBeEnabled();
    await gads.getByRole("button", { name: "Cancel" }).click();

    // Meta Ads takes a token from the store's own business, and says how to make one (0214).
    const meta = dialog.getByRole("listitem").filter({ hasText: "Meta Ads" });
    await meta.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(meta.getByText(/Use a token from your business, not your own login/)).toBeVisible();
    await expect(meta.getByLabel("System user access token")).toHaveAttribute("type", "password");
    await expect(meta.getByLabel("Ad account ID")).toBeVisible();
    await meta.screenshot({
      path: `${process.env.LOOK_DIR ?? "test-results"}/connections-meta-${test.info().project.name}.png`,
    });
    await meta.getByRole("button", { name: "Cancel" }).click();

    // GoSwift asks for what it gives on request, and says where to ask.
    const goswift = dialog.getByRole("listitem").filter({ hasText: "GoSwift" });
    await goswift.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(goswift.getByText(/tech-integrations@goswift\.in/)).toBeVisible();
    await expect(goswift.getByLabel("Client ID")).toBeVisible();
    await expect(goswift.getByLabel("API password")).toHaveAttribute("type", "password");
    await goswift.getByRole("button", { name: "Cancel" }).click();

    // A login the provider refuses is said in its words, and nothing is kept.
    const shiprocket = dialog.getByRole("listitem").filter({ hasText: "Shiprocket" });
    await shiprocket.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(dialog.getByText(/Use an API user, not your own login/)).toBeVisible();
    await dialog.getByLabel("API user email").fill("api@shop.in");
    await dialog.getByLabel("API user password").fill("wrong");
    await dialog.getByRole("button", { name: "Connect Shiprocket" }).click();
    await expect(dialog.getByText("These credentials do not match our records.")).toBeVisible();
    expect(added).toHaveLength(0);

    // The right one connects, and the row says so.
    await dialog.getByLabel("API user password").fill("right");
    await dialog.getByRole("button", { name: "Connect Shiprocket" }).click();
    await expect(dialog.getByText(/api@shop.in · connected, bringing its shipments in/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Sync now" })).toBeVisible();
    await page.screenshot({
      path: `${process.env.LOOK_DIR ?? "test-results"}/connections-${test.info().project.name}.png`,
    });

    // Disconnecting asks once, in place, and says the rows stay.
    await dialog.getByRole("button", { name: "Disconnect" }).click();
    await expect(dialog.getByText("Stop syncing? What it brought stays.")).toBeVisible();
    await dialog.getByRole("button", { name: "Disconnect" }).click();
    await expect(shiprocket.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
  } finally {
    await shop.admin.from("store_connections").delete().eq("store_id", shop.storeId);
  }
});
