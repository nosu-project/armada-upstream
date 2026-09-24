#!/usr/bin/env node
/**
 * Autonomous performance run: boots a PRODUCTION build of the real app in
 * headless Chromium, logged in as a throwaway key with a seeded DM history,
 * drives it through the situations users complain about, and writes what
 * `src/lib/perfRuntime.ts` and the browser measured.
 *
 *   npm run perf:profile                 # build + run every scenario
 *   node scripts/perf-profile.mjs --skip-build --idle 60
 *   node scripts/perf-profile.mjs --only idle-thread,switch
 *
 * Scenarios (each a fresh page on the same seeded origin):
 *   landing      logged-out root, idle
 *   boot         cold load straight into the big DM thread
 *   idle-thread  the big thread open, nobody touching anything
 *   scroll       paging the big thread's history back to the top
 *   switch       hopping between conversations, with heap after forced GC
 *                between rounds (a leak is a rising floor, not a rising peak)
 *   discover     /discover idle — the one scenario with real relay traffic
 *
 * Offline except `discover`: the seed goes straight into the app's own
 * ArmadaDB through the production writers (`e2e/screenshotSeed.ts`), and the
 * throwaway account has no relays. Nothing is ever published — the account is
 * minted here and never signs anything a relay keeps.
 *
 * Numbers are "CPU" in the sense Chromium's TaskDuration means it: main-thread
 * busy time over wall time. Headless, single-process (`--single-process`: see
 * playwright.config.ts for why some sandboxes need it), and on this machine's
 * cores — compare runs against each other, not against a phone.
 *
 * Output: `dist-perf/reports/<scenario>.json` (full reports) and a summary on
 * stdout.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { generateSecretKey, getEventHash, getPublicKey, nip19 } from "nostr-tools";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const IDLE_SEC = Number(opt("idle", "120"));
const ONLY = opt("only", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const PORT = 8282;
const ORIGIN = `http://localhost:${PORT}`;
const OUT = resolve(root, "dist-perf/reports");

const wants = (name) => ONLY.length === 0 || ONLY.includes(name);

// ─── Build + serve ──────────────────────────────────────────────────────────

if (!flag("skip-build")) {
  console.log("building (VITE_PROFILE=1, vite.config.perf.ts)…");
  const r = spawnSync("npx", ["vite", "build", "-l", "error", "-c", "vite.config.perf.ts"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, VITE_PROFILE: "1" },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
mkdirSync(OUT, { recursive: true });

const server = spawn("npx", ["vite", "preview", "-c", "vite.config.perf.ts"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
const stopServer = () => {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    // already gone
  }
};
process.on("exit", stopServer);
process.on("SIGINT", () => process.exit(130));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(ORIGIN);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`preview server never answered on ${ORIGIN}`);
}

// ─── The seeded world ───────────────────────────────────────────────────────

const nowSec = Math.floor(Date.now() / 1000);

function person(name) {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  return { sk, pubkey, npub: nip19.npubEncode(pubkey), name };
}

const LINES = [
  "did that invite link work for you?",
  "yeah im in",
  "ran 6 of us last night with screen share, no drops",
  "ok lets move raid night in there 👍",
  "bet. ill make a channel tonight",
  "check this out https://example.com/some/long/path?with=query",
  "lol",
  "can you send me the map file again, the last one was corrupted somewhere around the second floor",
  "**bold** and _italic_ and `code` all in one line",
  "> quoting what you said earlier\nand replying under it",
  "brb",
  "that emote pack goes hard",
];

/**
 * `peers` conversations; the first is the BIG thread (`bigThread` messages over
 * ~90 days), the rest a handful each. Every conversation has a message from me
 * so it lands in the inbox, not the request tier.
 */
function buildWorld({ peers: peerCount = 40, bigThread = 3000, small = 12 } = {}) {
  const me = person("perf-me");
  const peers = Array.from({ length: peerCount }, (_, i) => person(`peer${i}`));
  const profiles = [me, ...peers].map((p) => {
    const content = JSON.stringify({ name: p.name, about: `about ${p.name}` });
    const base = { pubkey: p.pubkey, kind: 0, created_at: nowSec - 86400 * 100, tags: [], content };
    return { rumorId: getEventHash(base), pubkey: p.pubkey, createdAt: base.created_at, content };
  });

  const messages = [];
  const dm = (author, other, content, createdAt) => {
    const tags = [["p", author === me ? other.pubkey : me.pubkey]];
    const base = { pubkey: author.pubkey, kind: 14, created_at: createdAt, tags, content };
    messages.push({
      rumorId: getEventHash(base),
      author: author.pubkey,
      peers: [other.pubkey],
      tags,
      content,
      createdAt,
      kind: 14,
    });
  };

  const span = 86400 * 90;
  for (let i = 0; i < bigThread; i++) {
    const author = i % 3 === 0 ? me : peers[0];
    dm(author, peers[0], `${LINES[i % LINES.length]} (#${i})`, nowSec - span + Math.floor((span * i) / bigThread));
  }
  peers.slice(1).forEach((p, pi) => {
    for (let i = 0; i < small; i++) {
      dm(i % 2 ? me : p, p, LINES[(i + pi) % LINES.length], nowSec - 86400 * (pi + 1) + i * 60);
    }
  });
  return { me, peers, payload: { self: me.pubkey, profiles, messages } };
}

// ─── Browser plumbing ───────────────────────────────────────────────────────

// ONE context and ONE page for the whole run: under `--single-process` a
// second browser context kills the browser. Scenarios are separated by full
// reloads instead, which is also what a cold start is.
// `--enable-precise-memory-info`: without it `performance.memory` is bucketed
// and cached, and the in-app heap samples read as a flat line.
const browser = await chromium.launch({ args: ["--single-process", "--enable-precise-memory-info"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: ORIGIN });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
page.on("crash", () => errors.push("RENDERER CRASHED"));
const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");

/**
 * Nothing this run does may land on a relay. The throwaway account still
 * behaves like a real one — it syncs read state (kind 30078), registers for
 * push (25742), etc. — so every outbound EVENT is swallowed here and answered
 * with the OK a relay would send, which keeps the client's publish path (and
 * its cost) exactly as it is in the field. Reads pass through untouched.
 */
const swallowed = {};
await page.routeWebSocket(/^wss?:\/\//, (ws) => {
  const server = ws.connectToServer();
  ws.onMessage((msg) => {
    if (typeof msg === "string" && msg.startsWith('["EVENT"')) {
      try {
        const event = JSON.parse(msg)[1];
        const d = event.tags?.find((t) => t[0] === "d")?.[1];
        const key = d === undefined ? String(event.kind) : `${event.kind}:${d}`;
        swallowed[key] = (swallowed[key] ?? 0) + 1;
        ws.send(JSON.stringify(["OK", event.id, true, ""]));
        return;
      } catch {
        return;
      }
    }
    server.send(msg);
  });
  server.onMessage((msg) => ws.send(msg));
});

/** Errors raised since `mark` (an index into `errors`). */
const errorsSince = (mark) => errors.slice(mark);

/** Log `who` in as an nsec account, the way the login dialog leaves storage. */
async function login(who) {
  const loginJson = JSON.stringify([
    {
      id: `nsec:${who.pubkey}`,
      type: "nsec",
      pubkey: who.pubkey,
      createdAt: new Date().toISOString(),
      data: { nsec: nip19.nsecEncode(who.sk) },
    },
  ]);
  await page.evaluate(
    ([json, pk]) => {
      localStorage.setItem("armada:login", json);
      localStorage.setItem("armada:active-pubkey", pk);
      // Skip the one-time "restore your setup" interstitial (best-effort; the
      // scenarios also dismiss it whenever it shows).
      localStorage.setItem(`armada:relay-prompt-shown:${pk}`, "1");
    },
    [loginJson, who.pubkey],
  );
}

async function metrics(cdp) {
  const { metrics: list } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(list.map((m) => [m.name, m.value]));
}

/** Heap after a forced full GC: the floor, which is what a leak raises. */
async function heapFloorMB(cdp) {
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  const m = await metrics(cdp);
  return Math.round((m.JSHeapUsedSize / 1048576) * 10) / 10;
}

/** Main-thread cost between two metric snapshots, as a share of wall time. */
function cost(a, b, wallSec) {
  const pct = (k) => Math.round(((b[k] - a[k]) / wallSec) * 1000) / 10;
  return {
    wallSec: Math.round(wallSec),
    cpuPct: pct("TaskDuration"),
    scriptPct: pct("ScriptDuration"),
    layoutPct: pct("LayoutDuration"),
    stylePct: pct("RecalcStyleDuration"),
    layouts: b.LayoutCount - a.LayoutCount,
    styleRecalcs: b.RecalcStyleCount - a.RecalcStyleCount,
    heapMB: Math.round((b.JSHeapUsedSize / 1048576) * 10) / 10,
    domNodes: b.Nodes,
    listeners: b.JSEventListeners,
  };
}

/** Dismiss the "restore your setup" interstitial whenever it shows. */
async function dismissRestore(page) {
  const skip = page.getByText("Skip for now");
  if (await skip.isVisible().catch(() => false)) {
    await skip.click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function until(page, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await dismissRestore(page);
    if (await predicate().catch(() => false)) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

const perfReady = (page) => page.waitForFunction(() => window.__armadaPerf?.json, null, { timeout: 60_000 });
const report = async (page) => JSON.parse(await page.evaluate(() => window.__armadaPerf.json()));
const resetCounters = (page) => page.evaluate(() => window.__armadaPerf.reset());

/** Measure `seconds` of whatever the page is doing, with fresh counters. */
async function measureIdle(page, cdp, seconds) {
  await resetCounters(page);
  const a = await metrics(cdp);
  const t = Date.now();
  await page.waitForTimeout(seconds * 1000);
  const b = await metrics(cdp);
  return cost(a, b, (Date.now() - t) / 1000);
}

/** Router navigation without a reload: what clicking a conversation does. */
const softNavigate = (page, path) =>
  page.evaluate((p) => {
    history.pushState({}, "", p);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);

const results = {};

function save(name, data) {
  // Publishes the client attempted during this scenario (all swallowed).
  data = { ...data, published: { ...swallowed } };
  for (const k of Object.keys(swallowed)) delete swallowed[k];
  results[name] = data;
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 2));
}

/** The parts of a runtime report worth reading in a summary. */
function digest(r) {
  const rt = r.runtime;
  return {
    longFrames: `${rt.frames.count} (${rt.frames.totalMs}ms, blocking ${rt.frames.blockingMs}ms, max ${rt.frames.maxMs}ms)`,
    commitsPerMin: rt.react.commitsPerMin,
    topRenders: rt.react.components.slice(0, 8).map((c) => `${c.name} ×${c.renders + c.mounts} (${c.selfMs}ms)${c.why ? ` why: ${c.why}` : ""}`),
    topScripts: rt.frames.scripts.slice(0, 5).map((s) => `${s.totalMs}ms ×${s.count} ${s.site}`),
    timers: `setTimeout ${rt.timers.setTimeoutPerSec}/s, rAF ${rt.timers.rafPerSec}/s, ${rt.timers.liveIntervals.length} live intervals`,
    busyIntervals: rt.timers.liveIntervals
      .filter((i) => i.fires > 0 && i.ms < 5000)
      .slice(0, 6)
      .map((i) => `${i.ms}ms ×${i.fires} ${i.site}`),
    rafSites: rt.timers.rafSites.slice(0, 3).map((s) => `~${s.estCalls} ${s.site}`),
    timeoutSites: rt.timers.timeoutSites.slice(0, 5).map((s) => `~${s.estCalls} ${s.site}`),
    animations: rt.animations.map((a) => `${a.name} ×${a.count} on ${a.target}`),
    relays: rt.relays.slice(0, 6).map(
      (x) => `${x.url} open=${x.open}/${x.opened} subs=${x.liveSubs} (peak ${x.peakSubs}) reqs=${x.reqs} ev=${x.events} in=${Math.round(x.bytesIn / 1024)}KB`,
    ),
    reqShapes: rt.reqShapes.slice(0, 6).map((s) => `${s.reqs} REQ, ${s.events} ev: ${s.shape}`),
    topStorage: r.boot.aggregates.slice(0, 6).map((a) => `${Math.round(a.total)}ms ×${a.count} ${a.label}`),
  };
}

// ─── Scenarios ──────────────────────────────────────────────────────────────

await waitForServer();
const world = buildWorld();
const big = world.peers[0];

const lastBig = `${LINES[(3000 - 1) % LINES.length]} (#2999)`;
const bigVisible = () => page.getByText(lastBig, { exact: false }).last().isVisible();

try {
  if (wants("landing")) {
    console.log(`\n▶ landing (logged out, ${IDLE_SEC}s idle)`);
    const mark = errors.length;
    await page.goto("/");
    await perfReady(page);
    await page.waitForTimeout(5000);
    const idle = await measureIdle(page, cdp, IDLE_SEC);
    save("landing", { idle, errors: errorsSince(mark), report: await report(page) });
  }

  // Seed through the production writers, on the app's own origin.
  await page.goto("/e2e/screenshotSeed.html");
  await login(world.me);
  await page.waitForFunction(() => Boolean(window.__armadaSeed), null, { timeout: 60_000 });
  const seedStart = Date.now();
  await page.evaluate((p) => window.__armadaSeed(p), world.payload);
  console.log(`\nseeded ${world.payload.messages.length} DMs across ${world.peers.length} conversations in ${Date.now() - seedStart}ms`);

  if (wants("boot") || wants("idle-thread") || wants("scroll")) {
    console.log("\n▶ boot (cold load into the big thread)");
    let mark = errors.length;
    const t0 = Date.now();
    await page.goto(`/dm/${big.npub}`);
    const painted = await until(page, bigVisible, 90_000);
    const bootMs = Date.now() - t0;
    await perfReady(page);
    save("boot", { bootMs, painted, errors: errorsSince(mark), report: await report(page) });

    if (wants("idle-thread")) {
      console.log(`▶ idle-thread (${IDLE_SEC}s)`);
      mark = errors.length;
      await page.waitForTimeout(5000);
      const idle = await measureIdle(page, cdp, IDLE_SEC);
      save("idle-thread", { idle, errors: errorsSince(mark), report: await report(page) });
    }

    if (wants("scroll")) {
      console.log("▶ scroll (page the big thread back)");
      mark = errors.length;
      await resetCounters(page);
      const a = await metrics(cdp);
      const t = Date.now();
      const steps = [];
      for (let i = 0; i < 40; i++) {
        const s = await page.evaluate(() => {
          const row = document.querySelector("[data-scroll-anchor]");
          let el = row?.parentElement ?? null;
          while (el && !(el.scrollHeight > el.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) {
            el = el.parentElement;
          }
          if (!el) return null;
          el.scrollTop = 0;
          return document.querySelectorAll("[data-scroll-anchor]").length;
        });
        steps.push(s);
        await page.waitForTimeout(750);
      }
      const b = await metrics(cdp);
      const reachedFirst = await page.getByText("(#0)", { exact: false }).count();
      save("scroll", {
        scroll: cost(a, b, (Date.now() - t) / 1000),
        renderedRowsPerStep: steps,
        reachedFirstMessage: reachedFirst > 0,
        errors: errorsSince(mark),
        report: await report(page),
      });
    }
  }

  if (wants("switch")) {
    console.log("\n▶ switch (conversation hopping, heap floor per round)");
    const mark = errors.length;
    await page.goto("/dm");
    await until(page, () => page.getByText("peer1", { exact: true }).first().isVisible(), 90_000);
    await perfReady(page);
    await page.waitForTimeout(3000);
    const floors = [await heapFloorMB(cdp)];
    await resetCounters(page);
    const a = await metrics(cdp);
    const t = Date.now();
    const targets = world.peers.slice(0, 15);
    for (let round = 0; round < 4; round++) {
      for (const p of targets) {
        await softNavigate(page, `/dm/${p.npub}`);
        await page.waitForTimeout(600);
      }
      floors.push(await heapFloorMB(cdp));
    }
    const b = await metrics(cdp);
    save("switch", {
      switches: targets.length * 4,
      cost: cost(a, b, (Date.now() - t) / 1000),
      heapFloorMBPerRound: floors,
      errors: errorsSince(mark),
      report: await report(page),
    });
  }

  if (wants("discover")) {
    console.log(`\n▶ discover (${IDLE_SEC}s idle, live relays)`);
    const mark = errors.length;
    await page.goto("/discover");
    await perfReady(page);
    await until(page, async () => false, 15_000);
    const idle = await measureIdle(page, cdp, IDLE_SEC);
    save("discover", { idle, errors: errorsSince(mark), report: await report(page) });
  }
} finally {
  await browser.close();
  stopServer();
}

// ─── Summary ────────────────────────────────────────────────────────────────

for (const [name, r] of Object.entries(results)) {
  console.log(`\n══ ${name} ══`);
  const { report: rep, ...rest } = r;
  console.log(JSON.stringify(rest, null, 1));
  if (rep) console.log(JSON.stringify(digest(rep), null, 1));
}
console.log(`full reports: ${OUT}`);
process.exit(0);
