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
    await expect(dialog.getByText("Coming soon: waiting on Meta's app review")).toBeVisible();
    await expect(dialog.getByText("Coming soon: waiting on Google's API approval")).toBeVisible();

    // A login the provider refuses is said in its words, and nothing is kept.
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
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
    await expect(dialog.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
  } finally {
    await shop.admin.from("store_connections").delete().eq("store_id", shop.storeId);
  }
});
