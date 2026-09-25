import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { loginAs, makePerson, profilesOf, settle, type Person } from "./screenshotWorld";

import type { ScriptedCommunity, ScriptedMessage } from "./concordSeed";

// Capture the product shots the signed-out landing page shows: the REAL routed
// app, open on each of five populated Concord communities (one per word the
// pitch cycles through), at a desktop and a phone size.
// Not part of `npm run test`; regenerate with
//
//   ARMADA_E2E_SINGLE_PROCESS=1 npx playwright test e2e/landing-screenshots.spec.ts
//
// Entirely offline. Profiles go in through `/e2e/screenshotSeed.html` and the
// communities through `/e2e/concordSeed.html`, both writing the app's own
// ArmadaDB through the production writers; the communities name an unroutable
// relay and nothing is ever published.
//
// Output is WebP (via ImageMagick's `magick`), since these ship in the static
// build and a PNG of the same frame is several times the size.

const dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(dir, "../public/landing");

/** Screenshot, then re-encode as WebP beside it and drop the PNG. */
async function shoot(page: Page, name: string) {
  mkdirSync(OUT_DIR, { recursive: true });
  const png = resolve(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: png });
  execFileSync("magick", [png, "-quality", "84", "-define", "webp:method=6", resolve(OUT_DIR, `${name}.webp`)]);
  rmSync(png);
}

const now = Math.floor(Date.now() / 1000);

/**
 * The cast: the viewer and the people in their five communities. Handles and
 * phrasing are the register the app is actually used in, not a pitch; nobody
 * in the chat is selling Armada to anybody, and nothing carries an em dash,
 * which reads as copywriting the moment it appears in a chat bubble.
 */
function cast() {
  const me = makePerson("pixelwitch", "", 286);
  // Cozy Co-op, and some of them in the Modding Den too.
  const kestrel = makePerson("voidkestrel", "raid lead, bad at healing", 338);
  const tunnel = makePerson("Tunnelsnake", "mapmaker", 166);
  const mochi = makePerson("mochi.exe", "emote goblin", 32);
  const grimble = makePerson("grimble", "", 208);
  const nullbyte = makePerson("nullbyte", "", 264);
  const juno = makePerson("juno", "chess nerd", 190);
  const birb = makePerson("birb", "", 120);
  // Dog-Eared.
  const maya = makePerson("maya", "reads three at once", 20);
  const theo = makePerson("theo", "", 200);
  const ines = makePerson("ines", "annotates in pen", 340);
  const ade = makePerson("ade", "", 95);
  // Static Bloom.
  const kit = makePerson("kit", "drums", 12);
  const rue = makePerson("rue", "vox / keys", 300);
  const sol = makePerson("sol", "bass", 175);
  // The Okafors.
  const mum = makePerson("Mum", "", 350);
  const dad = makePerson("Dad", "", 215);
  const ezi = makePerson("Ezi", "", 45);
  const kemi = makePerson("Kemi", "", 150);
  return {
    me, kestrel, tunnel, mochi, grimble, nullbyte, juno, birb,
    maya, theo, ines, ade, kit, rue, sol, mum, dad, ezi, kemi,
  };
}

type Cast = ReturnType<typeof cast>;

/** Glyphs for the community icons, white on the gradient. */
const GLYPHS = {
  pad:
    `<rect x="22" y="42" width="76" height="40" rx="20" fill="#fff"/>` +
    `<rect x="36" y="56" width="16" height="5" rx="2" fill="#000" fill-opacity=".55"/>` +
    `<rect x="41.5" y="50.5" width="5" height="16" rx="2" fill="#000" fill-opacity=".55"/>` +
    `<circle cx="76" cy="55" r="4" fill="#000" fill-opacity=".55"/><circle cx="84" cy="64" r="4" fill="#000" fill-opacity=".55"/>`,
  die:
    `<rect x="30" y="30" width="60" height="60" rx="12" fill="#fff"/>` +
    `<g fill="#000" fill-opacity=".55"><circle cx="46" cy="46" r="6"/><circle cx="60" cy="60" r="6"/><circle cx="74" cy="74" r="6"/></g>`,
  braces:
    `<path d="M48 30 H40 Q32 30 32 38 V52 Q32 60 24 60 Q32 60 32 68 V82 Q32 90 40 90 H48" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M72 30 H80 Q88 30 88 38 V52 Q88 60 96 60 Q88 60 88 68 V82 Q88 90 80 90 H72" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>`,
  book:
    `<path d="M24 36 Q42 30 58 38 V88 Q42 80 24 86 Z" fill="#fff"/>` +
    `<path d="M96 36 Q78 30 62 38 V88 Q78 80 96 86 Z" fill="#fff" fill-opacity=".8"/>`,
  note:
    `<path d="M48 30 L88 22 V74" fill="none" stroke="#fff" stroke-width="8" stroke-linejoin="round"/>` +
    `<path d="M48 30 V82" stroke="#fff" stroke-width="8"/>` +
    `<ellipse cx="38" cy="84" rx="12" ry="9" fill="#fff"/><ellipse cx="78" cy="76" rx="12" ry="9" fill="#fff"/>`,
  house:
    `<path d="M60 26 L96 58 H86 V92 H34 V58 H24 Z" fill="#fff"/>` +
    `<path d="M60 64 c-6-8-18-2-12 8 l12 10 l12-10 c6-10-6-16-12-8 Z" fill="#000" fill-opacity=".5"/>`,
};

/** A community icon: a glyph on a two-stop gradient, as a server owner would upload. */
function communityIcon(hue: number, glyph: keyof typeof GLYPHS): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue} 70% 50%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 70% 22%)"/>` +
    `</linearGradient></defs><rect width="120" height="120" fill="url(#g)"/>${GLYPHS[glyph]}</svg>`
  );
}

/** One community per word the landing's pitch cycles through. */
interface Shot {
  /** File stem: `community-<slug>-desktop.webp` and `-mobile.webp`. */
  slug: string;
  /** The newest message, which is what "the channel has painted" waits on. */
  lastLine: string;
  community: ScriptedCommunity;
}

function shots(c: Cast): Shot[] {
  const m = (author: Person, agoSec: number, content: string, extra: Partial<ScriptedMessage> = {}): ScriptedMessage => ({
    channel: 0,
    author: author.pubkey,
    agoSec,
    content,
    ...extra,
  });
  const react = (author: Person, target: string, emoji: string, agoSec: number): ScriptedMessage => ({
    channel: 0,
    author: author.pubkey,
    kind: 7,
    content: emoji,
    target,
    agoSec,
  });
  const reply = (author: Person, target: string, agoSec: number, content: string): ScriptedMessage => ({
    channel: 0,
    author: author.pubkey,
    kind: 1111,
    content,
    target,
    agoSec,
  });
  const side = (channel: number, author: Person, agoSec: number, content: string): ScriptedMessage => ({
    channel,
    author: author.pubkey,
    agoSec,
    content,
  });

  return [
    {
      slug: "raid-crew",
      lastLine: "gg in advance",
      community: {
        name: "Cozy Co-op",
        description: "game nights, mods and memes",
        iconSvg: communityIcon(318, "pad"),
        channels: [
          { name: "general", category: "lobby" },
          { name: "announcements", category: "lobby" },
          { name: "game-night", category: "play" },
          { name: "clips", category: "play" },
          { name: "lfg", category: "play", forum: true },
        ],
        roles: [
          { name: "mods", color: "#22d3ee", members: [c.kestrel.pubkey], hoist: true },
          { name: "regulars", color: "#f472b6", members: [c.tunnel.pubkey, c.nullbyte.pubkey, c.juno.pubkey], hoist: true },
        ],
        messages: [
          m(c.birb, 7200, "gm"),
          m(c.juno, 6900, "is the minecraft server up yet?"),
          m(c.kestrel, 6800, "yep same ip as last week"),
          m(c.grimble, 6000, "left my headset on all night again lol"),
          m(c.tunnel, 5200, "posted the new map in #clips"),
          m(c.mochi, 4700, "new emote pack is up, go wild"),
          m(c.nullbyte, 3400, "who's around tonight?"),
          m(c.mochi, 3300, "me! also tried the lantern theme, it's really nice", { key: "theme" }),
          react(c.juno, "theme", "🔥", 3250),
          react(c.kestrel, "theme", "🔥", 3240),
          react(c.nullbyte, "theme", "🔥", 3230),
          react(c.birb, "theme", "💜", 3220),
          m(c.kestrel, 2500, "we had 6 on voice last night with screen share and it held up fine", { key: "voice" }),
          m(c.juno, 2400, "good to know, the last app we tried kept dropping", { quote: "voice", key: "drops" }),
          react(c.kestrel, "drops", "👍", 2350),
          react(c.me, "drops", "👍", 2340),
          m(c.tunnel, 1600, "my friend's group wants to move their discord over. anyone done that?", { key: "move" }),
          m(c.me, 1500, "yeah i imported ours, channels and roles came over and most of the history", {
            quote: "move",
            key: "import",
          }),
          react(c.tunnel, "import", "🙏", 1450),
          react(c.mochi, "import", "🙌", 1440),
          reply(c.tunnel, "import", 1400, "nice, how long did it take?"),
          reply(c.me, "import", 1380, "maybe 10 min"),
          reply(c.tunnel, "import", 1300, "ok sending them the link"),
          m(c.juno, 700, "chess tourney friday 9pm in #game-night, bracket is pinned", { key: "chess" }),
          react(c.grimble, "chess", "♟️", 650),
          react(c.nullbyte, "chess", "♟️", 640),
          react(c.birb, "chess", "♟️", 630),
          m(c.nullbyte, 300, "i'm in. still salty about last week's final"),
          m(c.grimble, 40, "gg in advance"),
          side(1, c.me, 86400 * 2, "server rules are pinned, be nice"),
          side(2, c.juno, 5400, "bracket for friday is up"),
          side(3, c.tunnel, 5100, "new map flythrough"),
        ],
      },
    },
    {
      slug: "book-club",
      lastLine: "same. see you all thursday",
      community: {
        name: "Dog-Eared",
        description: "one book a month, no pressure to finish",
        iconSvg: communityIcon(24, "book"),
        channels: [
          { name: "general", category: "club" },
          { name: "this-month", category: "club" },
          { name: "spoilers", category: "club" },
          { name: "recs", category: "shelf", forum: true },
          { name: "quotes", category: "shelf" },
        ],
        roles: [
          { name: "host", color: "#fbbf24", members: [c.maya.pubkey], hoist: true },
          { name: "regulars", color: "#fb7185", members: [c.theo.pubkey, c.ines.pubkey], hoist: true },
        ],
        messages: [
          m(c.ade, 8000, "finally got my copy from the library"),
          m(c.theo, 7600, "how far is everyone?"),
          m(c.ines, 7400, "chapter 9. the lighthouse bit got me"),
          m(c.me, 7000, "same, had to put it down for a minute"),
          m(c.maya, 5400, "ok vote for next month is up, pick one", { key: "vote" }),
          react(c.theo, "vote", "📚", 5300),
          react(c.ines, "vote", "📚", 5290),
          react(c.ade, "vote", "📚", 5280),
          m(c.ade, 4200, "is the ending worth it? i'm stuck in the middle", { key: "stuck" }),
          m(c.ines, 4000, "push through, the last 50 pages are the whole book", { quote: "stuck", key: "push" }),
          react(c.ade, "push", "🙏", 3900),
          react(c.maya, "push", "💯", 3890),
          m(c.theo, 2600, "anyone want to do the call thursday instead of wednesday?", { key: "thurs" }),
          react(c.maya, "thurs", "👍", 2500),
          react(c.me, "thurs", "👍", 2490),
          react(c.ines, "thurs", "👍", 2480),
          reply(c.maya, "thurs", 2400, "thursday 8pm works, i'll move the event"),
          reply(c.theo, "thurs", 2300, "perfect"),
          m(c.me, 900, "the quote about the tide is going straight in #quotes"),
          m(c.maya, 400, "please bring snacks this time, theo"),
          m(c.theo, 200, "one time i forget"),
          m(c.ines, 60, "same. see you all thursday"),
          side(1, c.maya, 86400 * 3, "this month: The Lighthouse Keeper. call thursday 8pm"),
          side(4, c.ines, 86400, "\"the tide doesn't ask permission\""),
        ],
      },
    },
    {
      slug: "band",
      lastLine: "wear the ugly shirts",
      community: {
        name: "Static Bloom",
        description: "four chords and a van",
        iconSvg: communityIcon(270, "note"),
        channels: [
          { name: "general", category: "band" },
          { name: "setlist", category: "band" },
          { name: "demos", category: "studio" },
          { name: "lyrics", category: "studio" },
          { name: "merch", category: "shows" },
        ],
        roles: [
          { name: "band", color: "#a78bfa", members: [c.kit.pubkey, c.rue.pubkey, c.sol.pubkey], hoist: true },
        ],
        messages: [
          m(c.sol, 9000, "new bassline for the second verse, rough take in #demos"),
          m(c.rue, 8700, "oh that's so good", { key: "bass" }),
          m(c.kit, 8600, "finally something i can lock in with"),
          m(c.me, 7200, "rehearsal space is booked sat 2 to 6"),
          react(c.kit, "bass", "🔥", 8500),
          m(c.rue, 5000, "can we drop the bridge on the slow one? it drags live", { key: "bridge" }),
          m(c.sol, 4800, "yes please, i always lose count there", { quote: "bridge", key: "count" }),
          react(c.kit, "count", "😂", 4700),
          react(c.me, "count", "😂", 4690),
          m(c.kit, 3000, "venue sent the set times, we're on at 10:40", { key: "times" }),
          react(c.rue, "times", "🎸", 2900),
          react(c.sol, "times", "🎸", 2890),
          react(c.me, "times", "🥁", 2880),
          reply(c.rue, "times", 2800, "that's a good slot"),
          reply(c.sol, "times", 2700, "means we can soundcheck and eat first"),
          m(c.me, 1200, "setlist v3 is pinned, same order as last week minus the bridge"),
          m(c.sol, 500, "who's bringing the spare cables"),
          m(c.kit, 300, "me, and the tuner you left last time"),
          m(c.rue, 50, "wear the ugly shirts"),
          side(1, c.me, 1100, "1. glass 2. radio weather 3. the slow one 4. static bloom"),
          side(2, c.sol, 9100, "verse2_bass_rough.wav"),
        ],
      },
    },
    {
      slug: "dev-team",
      lastLine: "merged, thanks all",
      community: {
        name: "Modding Den",
        description: "the mod pack and everything around it",
        iconSvg: communityIcon(190, "braces"),
        channels: [
          { name: "general", category: "team" },
          { name: "standup", category: "team" },
          { name: "build-logs", category: "code" },
          { name: "reviews", category: "code" },
          { name: "help-desk", category: "support", forum: true },
        ],
        roles: [
          { name: "maintainers", color: "#34d399", members: [c.nullbyte.pubkey], hoist: true },
          { name: "contributors", color: "#60a5fa", members: [c.tunnel.pubkey, c.juno.pubkey, c.mochi.pubkey], hoist: true },
        ],
        messages: [
          m(c.juno, 8000, "standup notes are in #standup"),
          m(c.tunnel, 7600, "the new biome loader is up for review"),
          m(c.nullbyte, 7200, "looking at it now", { key: "look" }),
          m(c.mochi, 6000, "texture pack is 40% smaller after the compression pass", { key: "tex" }),
          react(c.nullbyte, "tex", "🚀", 5900),
          react(c.juno, "tex", "🚀", 5890),
          react(c.me, "tex", "🚀", 5880),
          m(c.juno, 4200, "anyone else seeing the crash on world load with shaders on?", { key: "crash" }),
          m(c.tunnel, 4000, "yep, only on the new loader. my bad, fixing", { quote: "crash", key: "fix" }),
          react(c.juno, "fix", "🙏", 3900),
          reply(c.nullbyte, "fix", 3500, "it's the chunk cache, it isn't cleared on reload"),
          reply(c.tunnel, "fix", 3300, "good catch, pushed a fix"),
          reply(c.juno, "fix", 3100, "confirmed, no crash here"),
          m(c.me, 1800, "release notes draft is in the forum, add anything i missed"),
          m(c.nullbyte, 600, "ci is green on the loader branch", { key: "ci" }),
          react(c.tunnel, "ci", "✅", 550),
          react(c.me, "ci", "✅", 540),
          m(c.tunnel, 60, "merged, thanks all"),
          side(1, c.juno, 8100, "yesterday: shader fixes. today: loader review. blockers: none"),
          side(2, c.nullbyte, 700, "build #412 passed in 3m 12s"),
        ],
      },
    },
    {
      slug: "family",
      lastLine: "love you all x",
      community: {
        name: "The Okafors",
        description: "",
        iconSvg: communityIcon(140, "house"),
        channels: [
          { name: "general", category: "home" },
          { name: "photos", category: "home" },
          { name: "recipes", category: "home" },
          { name: "trips", category: "plans" },
          { name: "birthdays", category: "plans" },
        ],
        roles: [{ name: "parents", color: "#f59e0b", members: [c.mum.pubkey, c.dad.pubkey], hoist: true }],
        messages: [
          m(c.mum, 9000, "who ate the last of the jollof"),
          m(c.ezi, 8800, "no comment"),
          m(c.dad, 8600, "it was very good"),
          m(c.kemi, 7000, "uploaded the beach photos to #photos", { key: "beach" }),
          react(c.mum, "beach", "❤️", 6900),
          react(c.dad, "beach", "❤️", 6890),
          react(c.me, "beach", "😂", 6880),
          m(c.mum, 5200, "sunday call at 5? grandma wants to see everyone", { key: "call" }),
          react(c.ezi, "call", "👍", 5100),
          react(c.kemi, "call", "👍", 5090),
          react(c.me, "call", "👍", 5080),
          reply(c.dad, "call", 5000, "i'll set up the laptop so she can see properly"),
          reply(c.mum, "call", 4900, "turn the volume up this time"),
          m(c.me, 3000, "put grandma's pepper soup recipe in #recipes before i forget it", { key: "soup" }),
          m(c.kemi, 2800, "finally, i've been guessing for years", { quote: "soup", key: "guess" }),
          react(c.mum, "guess", "😂", 2700),
          m(c.ezi, 900, "can someone pick me up from practice at 6"),
          m(c.dad, 800, "on my way at 5:45"),
          m(c.mum, 30, "love you all x"),
          side(2, c.me, 2900, "pepper soup: goat meat, scent leaves, lots of pepper, patience"),
        ],
      },
    },
  ];
}

/**
 * Nothing leaves the machine. The throwaway account behaves like a real one on
 * boot (it syncs its community list, registers for push), so every relay socket
 * is answered here instead of dialed: an OK for each EVENT, an EOSE for each
 * REQ, which also lets the timeline stop waiting on history that isn't coming.
 */
async function offline(page: Page) {
  await page.context().routeWebSocket(/.*/, (ws) => {
    ws.onMessage((msg) => {
      if (typeof msg !== "string") return;
      try {
        const [verb, arg] = JSON.parse(msg) as [string, unknown];
        if (verb === "REQ") ws.send(JSON.stringify(["EOSE", arg]));
        if (verb === "EVENT") ws.send(JSON.stringify(["OK", (arg as { id: string }).id, true, ""]));
      } catch {
        // not a Nostr frame: nothing to answer
      }
    });
  });
}

/** Boot logged in with the profiles and communities already in the store. */
async function bootSeeded(page: Page) {
  const c = cast();
  const people = Object.values(c);
  await offline(page);
  await loginAs(page, c.me);

  await page.goto("/e2e/screenshotSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeed));
  await page.evaluate((p) => window.__armadaSeed!(p), {
    self: c.me.pubkey,
    profiles: profilesOf(people, now - 86400),
    messages: [],
  });

  await page.goto("/e2e/concordSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeedConcordScript));
  const all = shots(c);
  const seeded = await page.evaluate((p) => window.__armadaSeedConcordScript!(p), {
    sk: Buffer.from(c.me.sk).toString("hex"),
    communities: all.map((shot) => shot.community),
  });
  return all.map((shot, i) => {
    const { communityId, channelIds } = seeded.communities[i];
    return { ...shot, path: `/c/${communityId}/${channelIds[0]}` };
  });
}

async function openGeneral(page: Page, path: string, lastLine: string) {
  await page.goto(path);
  await settle(page, () => page.getByText(lastLine).last().isVisible().catch(() => false));
  // Avatars are data URIs, but they still decode after the rows paint.
  await page.waitForTimeout(2000);
  await expect(page.getByText(lastLine).last()).toBeVisible();
}

/** Every community, one capture each, all from the one seeded store. */
async function shootAll(page: Page, size: "desktop" | "mobile") {
  for (const shot of await bootSeeded(page)) {
    await openGeneral(page, shot.path, shot.lastLine);
    await shoot(page, `community-${shot.slug}-${size}`);
  }
}

// One test per viewport, each in its own context: `--single-process` (which
// some sandboxes need, see playwright.config.ts) cannot survive a second
// context in one browser, so run these with more than one worker — the default
// — and each capture gets a browser of its own.
test.describe("desktop", () => {
  // Narrower than a typical desktop on purpose: the capture is shown well
  // under its own width, and a smaller window keeps its text legible there.
  test.use({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 2 });

  test("capture the communities", async ({ page }) => {
    test.setTimeout(180_000);
    await shootAll(page, "desktop");
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test("capture the communities", async ({ page }) => {
    test.setTimeout(180_000);
    await shootAll(page, "mobile");
  });
});
