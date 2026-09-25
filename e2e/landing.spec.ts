// The public landing page: it loads clean, and its booking form keeps one key.
//
// The key is what lets a booking that was sent twice (the answer never
// arrived) land once. It was made in render, so typing a name wrote a
// new one, and the server and the browser each rendered their own. Signed
// out, and it writes nothing: no booking is sent.
import { expect, test } from "@playwright/test";

test("the booking form keeps one key while it is filled in", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/#book");
  const key = page.locator('form input[name="idem"]');
  // Made once the page is running in the browser, never on the server.
  await expect(key).toHaveAttribute("value", /^[0-9a-f]{32}$/);
  const first = await key.getAttribute("value");
  await page.locator('form input[name="name"]').fill("Asha");
  await page.locator('form input[name="email"]').fill("asha@example.com");
  await expect(key).toHaveAttribute("value", first!);
  expect(errors, "uncaught errors in the page").toEqual([]);
});
