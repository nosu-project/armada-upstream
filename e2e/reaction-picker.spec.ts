import { expect, test, type Locator, type Page } from "@playwright/test";

import { loginAs, makePerson, profilesOf, settle } from "./screenshotWorld";

import type { ScriptedMessage } from "./concordSeed";

// The message hover toolbar and its emoji picker, on a seeded Concord channel.
// The picker is portalled outside the row, so it must not take the toolbar it
// is anchored to away while it is open, nor leave it stuck on after it closes.
//
//   ARMADA_E2E_SINGLE_PROCESS=1 npx playwright test e2e/reaction-picker.spec.ts

const now = Math.floor(Date.now() / 1000);

async function offline(page: Page) {
  await page.context().routeWebSocket(/.*/, (ws) => {
    ws.onMessage((msg) => {
      if (typeof msg !== "string") return;
      try {
        const [verb, arg] = JSON.parse(msg) as [string, unknown];
        if (verb === "REQ") ws.send(JSON.stringify(["EOSE", arg]));
        if (verb === "EVENT") ws.send(JSON.stringify(["OK", (arg as { id: string }).id, true, ""]));
      } catch {
        // not a Nostr frame
      }
    });
  });
}

async function bootChannel(page: Page) {
  const me = makePerson("viewer", "", 286);
  const ana = makePerson("ana", "", 20);
  const ben = makePerson("ben", "", 200);
  await offline(page);
  await loginAs(page, me);

  await page.goto("/e2e/screenshotSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeed));
  await page.evaluate((p) => window.__armadaSeed!(p), {
    self: me.pubkey,
    profiles: profilesOf([me, ana, ben], now - 86400),
    messages: [],
  });

  const messages: ScriptedMessage[] = Array.from({ length: 12 }, (_, i) => ({
    channel: 0,
    author: (i % 2 ? ana : ben).pubkey,
    agoSec: 3600 - i * 120,
    content: `line ${i + 1}`,
  }));
  await page.goto("/e2e/concordSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeedConcordScript));
  const seeded = await page.evaluate((p) => window.__armadaSeedConcordScript!(p), {
    sk: Buffer.from(me.sk).toString("hex"),
    communities: [{ name: "Picker", channels: [{ name: "general" }], messages }],
  });
  const { communityId, channelIds } = seeded.communities[0];
  await page.goto(`/c/${communityId}/${channelIds[0]}`);
  await settle(page, () => page.getByText("line 12").isVisible().catch(() => false));
  await expect(page.getByText("line 12")).toBeVisible();
}

/** The floating toolbar holding `button`, and its rendered opacity. */
function toolbarOf(button: Locator): Locator {
  return button.locator("xpath=ancestor::div[contains(@class,'group-hover:opacity-100')][1]");
}

async function opacity(el: Locator): Promise<number> {
  return Number(await el.evaluate((n) => getComputedStyle(n).opacity));
}

test.use({ viewport: { width: 1200, height: 800 } });

test("the toolbar stays while its picker is open, and goes once it closes", async ({ page }) => {
  test.setTimeout(120_000);
  await bootChannel(page);

  const line = page.getByText("line 6", { exact: true });
  await line.hover();
  const add = page.getByRole("button", { name: "Add reaction" }).filter({ visible: true }).first();
  const toolbar = toolbarOf(add);
  await expect.poll(() => opacity(toolbar)).toBe(1);

  await add.click();
  const picker = page.locator("em-emoji-picker");
  await expect(picker).toBeVisible();

  // Into the picker: the row is no longer hovered.
  const box = (await picker.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await page.waitForTimeout(400);
  await expect(picker).toBeVisible();
  expect.soft(await opacity(toolbar), "toolbar while its picker is open").toBe(1);

  await picker.locator("button[aria-label]").filter({ hasText: /\p{Extended_Pictographic}/u }).first().click();
  await expect(picker).toBeHidden();

  // Away from the row entirely: nothing should keep its toolbar up.
  await page.mouse.move(5, 790, { steps: 8 });
  await page.waitForTimeout(400);
  expect.soft(await opacity(toolbar), "toolbar after the picker closed, pointer elsewhere").toBe(0);
});

test("the right-click menu reacts from its top row and opens the picker", async ({ page }) => {
  test.setTimeout(120_000);
  await bootChannel(page);

  const row = page.locator("[data-event-id]").filter({ hasText: "line 4" });
  await page.getByText("line 4", { exact: true }).click({ button: "right" });
  const menu = page.getByRole("menu");
  const reactions = menu.getByRole("group", { name: "Reactions" });
  await expect(reactions.getByRole("menuitem")).toHaveCount(6);

  await reactions.getByRole("menuitem", { name: "React with 😂" }).click();
  await expect(menu).toBeHidden();
  await expect(row.getByRole("button", { name: "😂, 1 reaction" })).toBeVisible();

  await page.getByText("line 4", { exact: true }).click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Add reaction" }).click();
  const picker = page.locator("em-emoji-picker");
  await expect(picker).toBeVisible();
  await page.waitForTimeout(400);
  await expect(picker, "picker stays open once the menu has gone").toBeVisible();

  await picker.locator("input[type=search]").fill("rocket");
  await picker.locator("button[aria-label='🚀']").first().click();
  await expect(picker).toBeHidden();
  await expect(row.getByRole("button", { name: "🚀, 1 reaction" })).toBeVisible();
});
