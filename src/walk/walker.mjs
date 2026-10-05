// The walk itself: a section used in a real browser as a person would,
// by what the page says and offers (roles and names), never by its code.
// Every filter and each of its choices, the search, each column's sort,
// each tab, a row's button, and the form filled in and saved. What breaks
// is said as the person would meet it; the page's own errors too.
//
// Plain JavaScript with nothing imported, so the one walk runs in two
// places: the sandbox (lib/walk.ts reads this file and runs it there, with
// playwright-core) and the checks (e2e/walk.spec.ts). Steps are told back
// as { what, ok, why }; nothing is fixed here.

const QUICK = 2500;

/** Rows on the table now: rows with cells, not the head. */
const rowsShown = async (page) => page.locator("tbody tr").count();

/** What the page saved so far (src/walk/page.tsx). */
const writes = async (page) => page.evaluate(() => window.__WALK_WRITES__?.length ?? 0);

const BAD = /NaN|undefined|\[object Object\]|Infinity/;

export async function walk(page) {
  const steps = [];
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const step = async (what, run) => {
    const before = errors.length;
    try {
      const why = await run();
      if (errors.length > before)
        steps.push({ what, ok: false, why: `the page broke: ${errors.slice(before).join("; ").slice(0, 200)}` });
      else steps.push(why ? { what, ok: false, why } : { what, ok: true });
    } catch (e) {
      steps.push({
        what,
        ok: false,
        why: String(e?.message ?? e)
          .split("\n")[0]
          .slice(0, 200),
      });
    }
    await page.keyboard.press("Escape").catch(() => {});
  };

  await step("The section opens", async () => {
    await page.locator("main").waitFor({ timeout: 8000 });
    const text = await page.locator("main").innerText();
    if (BAD.test(text)) return `it shows "${text.match(BAD)[0]}" somewhere`;
  });

  // Each filter, and each of its choices.
  const filters = await page.getByRole("button", { name: /^Filter by / }).all();
  for (const f of filters) {
    const name = ((await f.getAttribute("aria-label")) ?? "a filter").replace(/: .*$/, "");
    await step(name, async () => {
      await f.click({ timeout: QUICK });
      const options = await page.getByRole("option").allInnerTexts();
      if (options.length < 2) return "it offers nothing to choose";
      await page.keyboard.press("Escape");
      for (const choice of options.slice(1, 7)) {
        await f.click({ timeout: QUICK });
        await page.getByRole("option", { name: choice, exact: true }).first().click({ timeout: QUICK });
        await page.waitForTimeout(100);
      }
      await f.click({ timeout: QUICK });
      await page.getByRole("option").first().click({ timeout: QUICK });
    });
  }

  // The search, with words a row really has.
  const search = page.getByRole("searchbox").first();
  if (await search.count()) {
    await step("Search", async () => {
      const word = (
        await page
          .locator("tbody tr td")
          .first()
          .innerText()
          .catch(() => "")
      )
        .trim()
        .split(/\s+/)[0];
      if (!word) return;
      await search.fill(word, { timeout: QUICK });
      await page.waitForTimeout(150);
      const n = await rowsShown(page);
      await search.fill("");
      if (n === 0) return `searching "${word}", a row's own words, finds nothing`;
    });
  }

  // Each column's sort.
  const heads = await page.locator("thead th button").all();
  if (heads.length)
    await step("Sorting by each column", async () => {
      for (const h of heads.slice(0, 12)) await h.click({ timeout: QUICK });
    });

  // Each tab.
  const tabs = await page.getByRole("tab").all();
  for (const t of tabs) {
    const name = (await t.innerText()).trim();
    await step(`The ${name} tab`, async () => {
      await t.click({ timeout: QUICK });
      await page.waitForTimeout(200);
    });
  }
  if (tabs.length) await tabs[0].click().catch(() => {});

  // A row's own buttons: the first one there is, pressed on the first row.
  const actions = await page.locator("tbody tr").first().getByRole("button").all();
  for (const b of actions.slice(0, 4)) {
    const name = ((await b.getAttribute("aria-label")) || (await b.innerText())).trim();
    if (!name || /copy/i.test(name)) continue;
    await step(`The ${name} button`, async () => {
      const was = await writes(page);
      await b.click({ timeout: QUICK });
      await page.waitForTimeout(200);
      if ((await writes(page)) === was) return `pressing ${name} changed nothing`;
    });
    break;
  }

  // The form: every field filled as a person would, then saved.
  const add = page.getByRole("button", { name: "Add", exact: true });
  if (await add.count()) {
    await step("Adding a row with the form", async () => {
      const rowsBefore = await rowsShown(page);
      const was = await writes(page);
      await add.click({ timeout: QUICK });
      const form = page.getByRole("dialog");
      await form.waitFor({ timeout: QUICK });
      for (const box of await form.getByRole("textbox").all()) await box.fill("Walk 1").catch(() => {});
      for (const n of await form.getByRole("spinbutton").all()) await n.fill("5").catch(() => {});
      for (const pick of await form.locator('button[aria-haspopup="listbox"]').all()) {
        await pick.click({ timeout: QUICK }).catch(() => {});
        const opts = page.getByRole("option");
        if ((await opts.count()) > 1)
          await opts
            .nth(1)
            .click({ timeout: QUICK })
            .catch(() => {});
        else await page.keyboard.press("Escape");
      }
      await form.getByRole("button", { name: /^(Add row|Save)$/ }).click({ timeout: QUICK });
      await page.waitForTimeout(300);
      if (await form.isVisible()) {
        const said = (
          await form
            .locator('[role="alert"]')
            .allInnerTexts()
            .catch(() => [])
        )
          .join(" ")
          .trim();
        return `the form would not save${said ? `: ${said.slice(0, 160)}` : ""}`;
      }
      if ((await writes(page)) === was) return "the form closed and saved nothing";
      if ((await rowsShown(page)) < Math.min(rowsBefore + 1, 50)) return "the row saved does not show on the table";
    });
  }

  // A written screen that broke while it ran, as the page around it heard.
  const broke = await page.evaluate(() => window.__WALK_BROKE__ ?? []).catch(() => []);
  if (broke.length)
    steps.push({ what: "The written screen", ok: false, why: broke.slice(0, 3).join("; ").slice(0, 300) });

  return { steps, errors: errors.slice(0, 10) };
}
