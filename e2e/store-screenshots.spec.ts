import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";
import {
  generateSecretKey,
  getEventHash,
  getPublicKey,
  nip19,
} from "nostr-tools";

// Capture the store/Flathub screenshots: the REAL routed app with its own
// chrome, not isolated components. Not part of `npm run test` — run with
// `npm run test:e2e`, or this file alone to regenerate the assets:
//
//   npx playwright test e2e/store-screenshots.spec.ts
//
// How the DM/discover shots boot the app populated, entirely offline (no relay):
//   1. `armada:login` (+ `armada:active-pubkey`) is set in an init script
//      before any app code runs, so the app renders as a logged-in nsec user.
//   2. The seed harness (`/e2e/screenshotSeed.html`) writes decrypted NIP-17
//      rumors + kind-0 profiles into the app's OWN ArmadaDB (IndexedDB, shared
//      per-origin) through the production writers, so the conversation-term
//      index is built exactly as it is in the field.
//   3. Navigating to `/dm/<npub>` on the same origin reads that store back.
//
// A DM thread is the one view whose data can be faithfully seeded locally — it
// is just decrypted rumors plus profiles. The Concord channel view would need
// the full CORD-01/02/05 derivation stack and the call view a live LiveKit
// room, so neither is captured here.

const dir = dirname(fileURLToPath(import.meta.url));
const out = (name: string) => resolve(dir, `../public/screenshots/${name}.png`);

// A fixed desktop window: wide enough that the rail, list and thread all show.
const VIEWPORT = { width: 1280, height: 800 };

async function shoot(page: Page, name: string) {
  const path = out(name);
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path });
}

interface Person {
  sk: Uint8Array;
  pubkey: string;
  npub: string;
  /** The display handle, in the community register the app is actually used in. */
  name: string;
  about: string;
  hue: number;
}

/**
 * A self-contained SVG avatar (no network). Deliberately NOT initials-on-a-disc:
 * at 32px in the conversation list that reads as a placeholder, and every row
 * looking like a placeholder is what makes a seeded capture look seeded. This is
 * a deterministic two-tone glyph mark on a gradient, so the rows look like
 * pictures people actually chose.
 */
function avatarDataUri(seed: string, hue: number): string {
  // Deterministic per handle, so re-running produces identical bytes.
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const a = `hsl(${hue} 62% 52%)`;
  const b = `hsl(${(hue + 38) % 360} 66% 34%)`;
  const shapes = [
    // A blocky arrow/chevron mark.
    `<path d="M34 78 L60 34 L86 78 L70 78 L60 60 L50 78 Z" fill="#fff" fill-opacity=".92"/>`,
    // Concentric rings.
    `<circle cx="60" cy="60" r="26" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="9"/>` +
      `<circle cx="60" cy="60" r="8" fill="#fff" fill-opacity=".9"/>`,
    // A pixel/dice cluster.
    `<g fill="#fff" fill-opacity=".9"><rect x="34" y="34" width="20" height="20" rx="4"/>` +
      `<rect x="66" y="34" width="20" height="20" rx="4"/>` +
      `<rect x="34" y="66" width="20" height="20" rx="4"/>` +
      `<rect x="66" y="66" width="20" height="20" rx="4" fill-opacity=".55"/></g>`,
    // A crescent/moon.
    `<path d="M74 30 a34 34 0 1 0 0 60 a27 27 0 1 1 0-60 Z" fill="#fff" fill-opacity=".92"/>`,
    // A stylised bolt.
    `<path d="M66 26 L38 66 L56 66 L50 94 L82 52 L62 52 Z" fill="#fff" fill-opacity=".92"/>`,
    // Stacked bars.
    `<g fill="#fff" fill-opacity=".9"><rect x="32" y="60" width="14" height="28" rx="4"/>` +
      `<rect x="53" y="44" width="14" height="44" rx="4"/>` +
      `<rect x="74" y="30" width="14" height="58" rx="4"/></g>`,
  ];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/>` +
    `</linearGradient></defs>` +
    `<rect width="120" height="120" rx="60" fill="url(#g)"/>` +
    shapes[h % shapes.length] +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function makePerson(name: string, about: string, hue: number): Person {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  return { sk, pubkey, npub: nip19.npubEncode(pubkey), name, about, hue };
}

// Seconds ago → an absolute unix timestamp, for natural-looking recency.
const now = Math.floor(Date.now() / 1000);
const ago = (secs: number) => now - secs;

interface SeededWorld {
  me: Person;
  peers: Person[];
  payload: unknown;
}

/**
 * The cast and their messages. Handles and phrasing are the register the app is
 * actually used in — community chat, not a press release — and carry no em
 * dashes, which read as copywriting the moment they appear in a chat bubble.
 */
function buildWorld(): SeededWorld {
  const me = makePerson("pixelwitch", "", 286);
  const peers = [
    makePerson("voidkestrel", "raid lead, bad at healing", 338),
    makePerson("Tunnelsnake", "mapmaker", 166),
    makePerson("mochi.exe", "emote goblin", 32),
    makePerson("grimble", "", 208),
    makePerson("nullbyte", "", 264),
  ];
  const open = peers[0]; // the thread we open and screenshot

  const everyone = [me, ...peers];
  const profiles = everyone.map((p) => {
    const content = JSON.stringify({
      name: p.name,
      about: p.about,
      picture: avatarDataUri(p.name, p.hue),
    });
    const base = {
      pubkey: p.pubkey,
      kind: 0,
      created_at: ago(86400),
      tags: [] as string[][],
      content,
    };
    return {
      rumorId: getEventHash(base),
      pubkey: p.pubkey,
      createdAt: base.created_at,
      content,
    };
  });

  // A DM rumor as seen by `me`: peer→me tags me, me→peer tags the peer; either
  // way `peers` (everyone but me) is the single other participant.
  const messages: Array<{
    rumorId: string;
    author: string;
    peers: string[];
    tags: string[][];
    content: string;
    createdAt: number;
    kind: number;
  }> = [];

  function dm(author: Person, other: Person, content: string, createdAt: number) {
    const base = {
      pubkey: author.pubkey,
      kind: 14,
      created_at: createdAt,
      tags: [["p", author.pubkey === me.pubkey ? other.pubkey : me.pubkey]],
      content,
    };
    messages.push({
      rumorId: getEventHash(base),
      author: author.pubkey,
      peers: [other.pubkey],
      tags: base.tags,
      content,
      createdAt,
      kind: 14,
    });
  }

  // The open thread: a natural back-and-forth, newest last.
  dm(open, open, "yo did that invite link work for you?", ago(7200));
  dm(me, open, "yeah im in. still weird that theres no server to join", ago(7080));
  dm(open, open, "thats the point lol, its all keys and relays", ago(6990));
  dm(me, open, "hows voice hold up with a full squad?", ago(6800));
  dm(open, open, "ran 6 of us last night with screen share, no drops", ago(6700));
  dm(me, open, "ok lets move raid night in there 👍", ago(600));
  dm(open, open, "bet. ill make a channel tonight", ago(420));

  // The other conversations: one line each, so the list has real rows. Each has
  // at least one message authored by me, so it lands in the inbox rather than
  // the request tier (mine ⇒ known).
  dm(peers[1], peers[1], "new map is up, wanna test it?", ago(1800));
  dm(me, peers[1], "queueing now", ago(1500));
  dm(me, peers[2], "that emote pack goes hard", ago(9000));
  dm(peers[2], peers[2], "ty!! more on friday", ago(8700));
  dm(peers[3], peers[3], "we still on for friday?", ago(20000));
  dm(me, peers[3], "yep 8pm", ago(19800));
  dm(me, peers[4], "welcome to the crew", ago(50000));

  return { me, peers, payload: { self: me.pubkey, profiles, messages } };
}

/** Set `armada:login` before any app code runs, so the app boots logged in. */
async function loginAs(page: Page, me: Person) {
  const login = [
    {
      id: `nsec:${me.pubkey}`,
      type: "nsec",
      pubkey: me.pubkey,
      createdAt: new Date().toISOString(),
      data: { nsec: nip19.nsecEncode(me.sk) },
    },
  ];
  await page.context().addInitScript(
    ([loginJson, pubkey]) => {
      localStorage.setItem("armada:login", loginJson);
      localStorage.setItem("armada:active-pubkey", pubkey);
    },
    [JSON.stringify(login), me.pubkey] as const,
  );
}

/**
 * An account whose relay list can't be found offline gets a one-time "restore
 * your setup" interstitial, which can cover the app either before or after the
 * view paints. Dismiss it whenever it shows.
 */
async function dismissRestore(page: Page): Promise<boolean> {
  const skip = page.getByText("Skip for now");
  if (await skip.isVisible().catch(() => false)) {
    await skip.click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
    return true;
  }
  return false;
}

/** Poll until `ready` paints, dismissing the interstitial as it appears. */
async function settle(page: Page, ready: () => Promise<boolean>) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await dismissRestore(page)) continue;
    if (await ready()) break;
    await page.waitForTimeout(500);
  }
}

/** Boot logged in with the seeded world already in the store. */
async function bootSeeded(page: Page) {
  const world = buildWorld();
  await loginAs(page, world.me);
  await page.setViewportSize(VIEWPORT);

  await page.goto("/e2e/screenshotSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeed));
  await page.evaluate((p) => window.__armadaSeed!(p), world.payload);

  return world;
}

test("capture a populated DM view", async ({ page }) => {
  const { peers } = await bootSeeded(page);
  const open = peers[0];

  await page.goto(`/dm/${open.npub}`);
  await settle(page, async () => {
    const bubble = page.getByText("bet. ill make a channel tonight").last();
    return await bubble.isVisible().catch(() => false);
  });
  await page.waitForTimeout(1000);

  await expect(
    page.getByText("bet. ill make a channel tonight").last(),
  ).toBeVisible();
  await shoot(page, "dms");
});

/**
 * Wait for every `<img>` in the document to finish decoding. Discover's banners
 * and avatars are fetched from Blossom servers, so they arrive well after the
 * route's own chrome paints — and they arrive UNEVENLY: a card whose banner is
 * still in flight renders the letter placeholder, so a capture taken when only
 * some have landed shows a grid that is half placeholders.
 *
 * Three things this has to survive. The element count itself keeps moving,
 * since a card mounts its `<img>` only once the URL resolves, so "all loaded"
 * is only meaningful once the TOTAL has also stopped growing — and it grows in
 * bursts as each community's metadata lands, so the quiet window has to be long
 * enough that a gap between bursts is not mistaken for the end. Only images
 * INSIDE the captured viewport are counted: the grid scrolls far past the
 * screenshot, and a lazy `<img>` below the fold never loads at all, so counting
 * it makes "everything decoded" unreachable and drops every run onto the
 * give-up path below — which is what took a capture while a visible banner was
 * still in flight. And a host that is slow or gone would otherwise hang the
 * run, so a stable-but-incomplete count is still accepted once it has held much
 * longer — the capture is then as good as that run can get rather than a
 * failure.
 */
async function waitForImages(page: Page, timeoutMs: number) {
  const counts = () =>
    page.evaluate(() => {
      const imgs = [...document.images].filter((i) => {
        const r = i.getBoundingClientRect();
        return (
          r.width > 0 &&
          r.height > 0 &&
          r.top < window.innerHeight &&
          r.bottom > 0
        );
      });
      return {
        total: imgs.length,
        // SETTLED, not decoded: an image that errored is `complete` with a
        // zero `naturalWidth` and will never change again. Counting only
        // successes leaves one dead Blossom host holding the loop open until
        // the give-up path fires, which is what took a capture while OTHER
        // banners were still genuinely in flight.
        settled: imgs.filter((i) => i.complete).length,
        decoded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
      };
    });

  const deadline = Date.now() + timeoutMs;
  let last = { total: 0, settled: 0, decoded: 0 };
  let stable = 0;
  while (Date.now() < deadline) {
    const now = await counts();
    stable =
      now.total === last.total && now.settled === last.settled ? stable + 1 : 0;
    last = now;
    // Everything that mounted DECODED, and nothing new mounted for ~25s. This
    // is the only exit that means the grid is actually full: a card mounts its
    // `<img>` only after its metadata resolves, so the quiet window is doing
    // the real work — the count must stop growing, not merely stop changing
    // between two samples.
    if (stable >= 25 && now.total > 0 && now.decoded === now.total) break;
    // Same, but with at least one image that errored — `complete` with a zero
    // `naturalWidth`, which will never change again. Held longer because an
    // error can also be a host that is only intermittently failing.
    if (stable >= 45 && now.total > 0 && now.settled === now.total) break;
    // Nothing has moved at all for ~90s: a host is hanging rather than
    // failing, so take what we have rather than burning the whole deadline.
    if (stable >= 90 && now.decoded > 0) break;
    await page.waitForTimeout(1000);
  }
  return last;
}

test("capture the discovery page", async ({ page }) => {
  await bootSeeded(page);

  await page.goto("/discover");
  // Nothing here is seeded — the directory and its images are relay/Blossom
  // supplied — so there is no content predicate to wait on beyond the route's
  // own chrome and the images landing.
  await settle(page, async () => true);
  await page.waitForLoadState("networkidle").catch(() => {});
  const loaded = await waitForImages(page, 180_000);
  // Not `settled`: an image that errored is settled too, and a grid of letter
  // placeholders would pass that.
  expect(loaded.decoded).toBeGreaterThan(0);
  await shoot(page, "discover");
});

test("capture the landing page", async ({ page }) => {
  // Deliberately no `loginAs`: the marketing landing page is what a logged-out
  // visitor sees at the root route.
  await page.setViewportSize(VIEWPORT);
  await page.goto("/");
  await page.waitForTimeout(3000);
  await shoot(page, "landing");
});
