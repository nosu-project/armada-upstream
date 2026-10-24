import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { getEventHash } from "nostr-tools";

import { loginAs, makePerson, profilesOf, settle } from "./screenshotWorld";

// The mobile DM drill-down (SwipeReveal over the conversation list), driven by
// compositor touches through CDP so touch-action and the browser's own
// pointercancel behave as on a phone; Playwright's touchscreen only taps.

test.use({
  viewport: { width: 400, height: 860 },
  hasTouch: true,
  isMobile: true,
  launchOptions: {
    args: [
      // Android's slop (8dp). Desktop Chromium's 15px jumps a slow drag past the
      // claim threshold before the browser can start a pan, hiding the bug.
      "--touch-slop-distance=8",
      ...(process.env.ARMADA_E2E_SINGLE_PROCESS ? ["--single-process"] : []),
    ],
  },
});

const WIDTH = 400;
const Y = 500;
const now = Math.floor(Date.now() / 1000);

async function bootInThread(page: Page) {
  const me = makePerson("me", "", 200);
  const peer = makePerson("peer", "", 30);
  const rumors = [
    { pubkey: peer.pubkey, kind: 14, created_at: now - 60, tags: [["p", me.pubkey]], content: "hello there" },
    { pubkey: me.pubkey, kind: 14, created_at: now - 30, tags: [["p", peer.pubkey]], content: "hi back" },
  ];
  const messages = rumors.map((e) => ({
    rumorId: getEventHash(e),
    author: e.pubkey,
    peers: [peer.pubkey],
    tags: e.tags,
    content: e.content,
    createdAt: e.created_at,
    kind: 14,
  }));
  await loginAs(page, me);
  await page.goto("/e2e/screenshotSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeed));
  await page.evaluate(
    (p) => window.__armadaSeed!(p),
    { self: me.pubkey, profiles: profilesOf([me, peer], now - 3600), messages },
  );
  await page.goto(`/dm/${peer.npub}`);
  await settle(page, async () => page.getByText("hi back").last().isVisible().catch(() => false));
  await expect(page.getByText("hi back").last()).toBeVisible();
}

/** The SwipeReveal pane's offset: the positioned parent of the chat `<main>`. */
function paneOffset(page: Page): Promise<number> {
  return page.evaluate(() => {
    const pane = document.querySelector("main")?.parentElement;
    return pane ? new DOMMatrix(getComputedStyle(pane).transform).m41 : NaN;
  });
}

/** A one-finger horizontal drag, one move of `pxPerFrame` per 16ms frame. */
async function drag(cdp: CDPSession, page: Page, from: number, to: number, pxPerFrame: number) {
  const point = (x: number) => [{ x, y: Y, radiusX: 4, radiusY: 4, force: 1, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(from) });
  const dir = Math.sign(to - from);
  const samples: { offset: number; placeholder: boolean }[] = [];
  for (let x = from; dir * (to - x) > 0; x += dir * pxPerFrame) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(x) });
    await page.waitForTimeout(16);
    samples.push({
      offset: await paneOffset(page),
      placeholder: await page.getByText("Select a conversation").isVisible().catch(() => false),
    });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  return samples;
}

test("a swipe from the DM list drags the thread back in at any speed", async ({ page }) => {
  test.setTimeout(240_000);
  await bootInThread(page);
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => {
    const w = window as unknown as { __browserCancels: number };
    w.__browserCancels = 0;
    window.addEventListener("pointercancel", (e) => e.isTrusted && w.__browserCancels++, true);
  });

  // 2 and 10 px/frame were the speeds whose first move past the slop landed
  // under the claim threshold, letting the browser take the pan.
  for (const speed of [40, 10, 6, 2]) {
    await drag(cdp, page, 60, 360, 40);
    await expect.poll(() => paneOffset(page)).toBeGreaterThanOrEqual(WIDTH - 1);
    await expect.poll(() => page.evaluate(() => location.pathname)).toBe("/dm");
    await page.evaluate(() => ((window as unknown as { __browserCancels: number }).__browserCancels = 0));

    const samples = await drag(cdp, page, 340, 40, speed);
    const moving = samples.filter((s) => s.offset < WIDTH - 1);
    expect(moving.length, `pane moved at ${speed}px/frame`).toBeGreaterThan(0);
    expect(moving.some((s) => s.placeholder), `empty state mid-drag at ${speed}px/frame`).toBe(false);
    expect(await page.evaluate(() => (window as unknown as { __browserCancels: number }).__browserCancels)).toBe(0);
    await expect.poll(() => paneOffset(page)).toBe(0);
    await expect.poll(() => page.evaluate(() => location.pathname)).toMatch(/^\/dm\/npub1/);
    await expect(page.getByText("hi back").last()).toBeVisible();
  }
});
