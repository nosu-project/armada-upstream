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

// The composer remounts per conversation; a draft typed just before switching
// must survive the unmount, and must not follow into the next channel.
//
//   ARMADA_E2E_SINGLE_PROCESS=1 npx playwright test e2e/composer-drafts.spec.ts

test("a draft typed right before a channel switch is kept for its channel", async ({ page }) => {
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
  const messages: ScriptedMessage[] = [
    { channel: 0, author: ana.pubkey, agoSec: 60, content: "in general" },
    { channel: 1, author: ana.pubkey, agoSec: 60, content: "in random" },
  ];
  await page.goto("/e2e/concordSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeedConcordScript));
  const seeded = await page.evaluate((p) => window.__armadaSeedConcordScript!(p), {
    sk: Buffer.from(me.sk).toString("hex"),
    communities: [{ name: "M", channels: [{ name: "general" }, { name: "random" }], messages }],
  });
  const { communityId, channelIds } = seeded.communities[0];
  await page.goto(`/c/${communityId}/${channelIds[0]}`);
  await settle(page, () => page.getByText("in general").isVisible().catch(() => false));

  const field = page.getByRole("textbox").last();
  await field.click();
  await page.keyboard.type("half a thought");
  // Inside the save debounce: only the unmount can persist it.
  await page.getByRole("button", { name: "random", exact: true }).first().click();
  await settle(page, () => page.getByText("in random").isVisible().catch(() => false));
  await expect(page.getByRole("textbox").last()).toHaveValue("");

  await page.getByRole("button", { name: "general", exact: true }).first().click();
  await settle(page, () => page.getByText("in general").isVisible().catch(() => false));
  await expect(page.getByRole("textbox").last()).toHaveValue("half a thought");
});
