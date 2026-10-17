import { expect, test, type Page } from "@playwright/test";

import { loginAs, makePerson, profilesOf, settle } from "./screenshotWorld";

import type { ScriptedMessage } from "./concordSeed";

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

test.use({ viewport: { width: 1200, height: 800 } });

// Mentions in the composer read `@Name` but are sent as `nostr:npub1…`.
//
//   ARMADA_E2E_SINGLE_PROCESS=1 npx playwright test e2e/composer-mentions.spec.ts

test("typing after a picked mention keeps it", async ({ page }) => {
  test.setTimeout(120_000);
  const me = makePerson("viewer", "", 286);
  const ana = makePerson("ana", "", 20);
  await offline(page);
  await loginAs(page, me);
  await page.goto("/e2e/screenshotSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeed));
  await page.evaluate((p) => window.__armadaSeed!(p), {
    self: me.pubkey,
    profiles: profilesOf([me, ana], now - 86400),
    messages: [],
  });
  const messages: ScriptedMessage[] = [{ channel: 0, author: ana.pubkey, agoSec: 60, content: "hello" }];
  await page.goto("/e2e/concordSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeedConcordScript));
  const seeded = await page.evaluate((p) => window.__armadaSeedConcordScript!(p), {
    sk: Buffer.from(me.sk).toString("hex"),
    communities: [{ name: "M", channels: [{ name: "general" }], messages }],
  });
  const { communityId, channelIds } = seeded.communities[0];
  await page.goto(`/c/${communityId}/${channelIds[0]}`);
  await settle(page, () => page.getByText("hello").isVisible().catch(() => false));

  const field = page.getByRole("textbox").last();
  await field.click();
  await page.keyboard.type("hi @an");
  await expect(page.locator("[data-mention-item]")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(field).toHaveValue("hi @ana ");

  // The name may resolve while the keystrokes land; the mention must survive both.
  await page.keyboard.type("xyz more");
  await expect(field).toHaveValue("hi @ana xyz more");

  await page.keyboard.press("Enter");
  const sent = page.locator("[data-event-id]").filter({ hasText: "xyz more" });
  await expect(sent.getByRole("button", { name: "@ana" })).toBeVisible();
});
