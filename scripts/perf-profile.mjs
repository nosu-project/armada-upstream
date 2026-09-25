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
 *   node scripts/perf-profile.mjs --only concord-switch --cpu-profile   # + hot functions
 *   node scripts/perf-profile.mjs --react-timings   # per-component self ms (inflates CPU)
 *
 * Scenarios (each a fresh page on the same seeded origin):
 *   landing      logged-out root, idle
 *   boot         cold load straight into the big DM thread
 *   idle-thread  the big thread open, nobody touching anything
 *   scroll       paging the big thread's history back to the top
 *   switch       hopping between conversations, with heap after forced GC
 *                between rounds (a leak is a rising floor, not a rising peak)
 *   concord-boot    cold load into a seeded community's 3000-message #general
 *   concord-idle    #general open, nobody touching anything
 *   concord-scroll  paging #general's history back
 *   concord-switch  hopping between the community's channels, heap per round
 *   discover     /discover idle — the one scenario with real relay traffic
 *
 * Offline except `discover`: the seeds go straight into the app's own
 * ArmadaDB through the production writers (`e2e/screenshotSeed.ts`,
 * `e2e/concordSeed.ts`), and the throwaway account has no relays. The seeded
 * community names `wss://relay.invalid`, which the harness answers itself. Nothing is ever published — the account is
 * minted here and never signs anything a relay keeps.
 *
 * Numbers are "CPU" in the sense Chromium's TaskDuration means it: main-thread
 * busy time over wall time. Headless, single-process (`--single-process`: see
 * playwright.config.ts for why some sandboxes need it), and on this machine's
 * cores — compare runs against each other, not against a phone.
 *
 * Output: `perf-reports/<scenario>.json` (full reports) and a summary on
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
// Outside `dist-perf/`, which every build empties.
const OUT = resolve(root, "perf-reports");
/** Messages in the seeded community's #general. */
const CONCORD_BIG = 3000;

const wants = (name) => ONLY.length === 0 || ONLY.includes(name);

// ─── Build + serve ──────────────────────────────────────────────────────────

if (!flag("skip-build")) {
  console.log(`building (VITE_PROFILE=1${flag("react-timings") ? ", VITE_PROFILE_REACT=1" : ""}, vite.config.perf.ts)…`);
  const r = spawnSync("npx", ["vite", "build", "-l", "error", "-c", "vite.config.perf.ts"], {
    cwd: root,
    stdio: "inherit",
    // `--react-timings`: React's profiling build, for per-component self time.
    // Off by default — its render logging inflates CPU (see vite.config.ts).
    env: { ...process.env, VITE_PROFILE: "1", ...(flag("react-timings") ? { VITE_PROFILE_REACT: "1" } : {}) },
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
  // The seeded community names `wss://relay.invalid`: answer it here as an
  // empty relay (EOSE for every REQ) rather than dialing nothing and leaving
  // its reads to time out.
  const fake = /\.invalid(?:[:/]|$)/.test(new URL(ws.url()).hostname + "/");
  const server = fake ? null : ws.connectToServer();
  ws.onMessage((msg) => {
    if (fake && typeof msg === "string" && msg.startsWith('["REQ"')) {
      try {
        ws.send(JSON.stringify(["EOSE", JSON.parse(msg)[1]]));
      } catch {
        // malformed REQ: nothing to answer
      }
      return;
    }
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
    server?.send(msg);
  });
  server?.onMessage((msg) => ws.send(msg));
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
    queries: (rt.queries ?? []).slice(0, 8).map((q) => `${q.fetches} fetch / ${q.updates} update / ${q.observers} obs: ${q.family}`),
    topStorage: r.boot.aggregates.slice(0, 6).map((a) => `${Math.round(a.total)}ms ×${a.count} ${a.label}`),
  };
}

/**
 * Sampling CPU profile of `fn`, reduced to the top self-time functions
 * (name + file:line, names kept by the profile build). `--cpu-profile` only:
 * the sampler's own overhead would skew every other number in the run.
 */
async function cpuProfile(fn) {
  if (!flag("cpu-profile")) return { result: await fn(), hot: undefined };
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  const result = await fn();
  const { profile } = await cdp.send("Profiler.stop");
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const dt = new Map();
  profile.samples.forEach((id, i) => dt.set(id, (dt.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
  const self = new Map();
  for (const [id, us] of dt) {
    const { functionName, url, lineNumber } = byId.get(id).callFrame;
    const file = url.replace(/^.*\/assets\//, "").replace(/-[\w-]{8}\.js$/, ".js");
    const key = `${functionName || "(anonymous)"} ${file}:${lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + us);
  }
  const hot = [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([fn, us]) => `${Math.round(us / 1000)}ms ${fn}`);
  return { result, hot };
}

/**
 * Where the page's event listeners are: per event type, and per element (tag
 * + first class) for the heaviest holders. Uses the DevTools command-line
 * `getEventListeners`, so it walks every element — harness-only, and run
 * after a scenario's measurement, never inside one.
 */
async function listenerCensus() {
  const { result } = await cdp.send("Runtime.evaluate", {
    includeCommandLineAPI: true,
    returnByValue: true,
    expression: `(() => {
      const byType = {}, byElement = {};
      let total = 0;
      const targets = [window, document, ...document.querySelectorAll("*")];
      for (const el of targets) {
        const ls = getEventListeners(el);
        let n = 0;
        for (const [type, list] of Object.entries(ls)) { byType[type] = (byType[type] || 0) + list.length; n += list.length; }
        if (!n) continue;
        total += n;
        const name = el === window ? "window" : el === document ? "document" : el.tagName.toLowerCase() + (el.classList[0] ? "." + el.classList[0] : "");
        byElement[name] = (byElement[name] || 0) + n;
      }
      const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 12);
      return { total, byType: top(byType), byElement: top(byElement) };
    })()`,
  });
  // JSEventListeners also counts non-DOM targets (AbortSignals, IDB requests,
  // media queries) that no census can enumerate; after a full GC, what remains
  // is held, not garbage.
  await heapFloorMB(cdp);
  return { ...result.value, jsListenersAfterGc: (await metrics(cdp)).JSEventListeners };
}

/**
 * Scroll the open timeline to its top 40 times, 750ms apart — each one asks it
 * for older history. Returns the rendered row count after each step.
 */
async function scrollBack() {
  const steps = [];
  for (let i = 0; i < 40; i++) {
    const rows = await page.evaluate(() => {
      const row = document.querySelector("[data-scroll-anchor]");
      let el = row?.parentElement ?? null;
      while (el && !(el.scrollHeight > el.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) {
        el = el.parentElement;
      }
      if (!el) return null;
      el.scrollTop = 0;
      return document.querySelectorAll("[data-scroll-anchor]").length;
    });
    steps.push(rows);
    await page.waitForTimeout(750);
  }
  return steps;
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
      const steps = await scrollBack();
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

  const concordScenarios = ["concord-boot", "concord-idle", "concord-scroll", "concord-switch"];
  if (concordScenarios.some(wants)) {
    // Seed a community: a 3000-message #general and seven small channels.
    await page.goto("/e2e/concordSeed.html");
    await page.waitForFunction(() => Boolean(window.__armadaSeedConcord), null, { timeout: 60_000 });
    const seedAt = Date.now();
    const concord = await page.evaluate(
      (p) => window.__armadaSeedConcord(p),
      {
        sk: Buffer.from(world.me.sk).toString("hex"),
        others: world.peers.slice(0, 8).map((p) => p.pubkey),
        channelSizes: [CONCORD_BIG, 60, 60, 60, 60, 60, 60, 60],
        lines: LINES,
      },
    );
    console.log(`\nseeded community ${concord.communityId.slice(0, 8)}… (${CONCORD_BIG} + 7×60 messages) in ${Date.now() - seedAt}ms`);
    const channelPath = (i) => `/c/${concord.communityId}/${concord.channelIds[i]}`;
    const lastGeneral = `${LINES[(CONCORD_BIG - 1) % LINES.length]} (#${CONCORD_BIG - 1})`;
    const generalVisible = () => page.getByText(lastGeneral, { exact: false }).last().isVisible();

    console.log("\n▶ concord-boot (cold load into #general)");
    let mark = errors.length;
    const t0 = Date.now();
    await page.goto(channelPath(0));
    const painted = await until(page, generalVisible, 90_000);
    const bootMs = Date.now() - t0;
    await perfReady(page);
    // Sanity-check a lazily built control still works: the first avatar's
    // profile card must open on its first click.
    const profileCardOpens = await (async () => {
      const avatar = page.locator('[data-scroll-anchor] button[aria-haspopup="dialog"]').last();
      if (!(await avatar.count())) return false;
      await avatar.click({ timeout: 5000 }).catch(() => undefined);
      const opened = await page.locator('[role="dialog"]').first().isVisible({ timeout: 3000 }).catch(() => false);
      await page.keyboard.press("Escape");
      return opened;
    })();
    save("concord-boot", { bootMs, painted, profileCardOpens, errors: errorsSince(mark), report: await report(page) });

    if (wants("concord-idle")) {
      console.log(`▶ concord-idle (${IDLE_SEC}s)`);
      mark = errors.length;
      await page.waitForTimeout(5000);
      const idle = await measureIdle(page, cdp, IDLE_SEC);
      save("concord-idle", { idle, errors: errorsSince(mark), report: await report(page) });
    }

    if (wants("concord-scroll")) {
      console.log("▶ concord-scroll (page #general back)");
      mark = errors.length;
      await resetCounters(page);
      const a = await metrics(cdp);
      const t = Date.now();
      const steps = await scrollBack();
      const b = await metrics(cdp);
      const reachedFirst = await page.getByText("(#0)", { exact: false }).count();
      save("concord-scroll", {
        scroll: cost(a, b, (Date.now() - t) / 1000),
        renderedRowsPerStep: steps,
        reachedFirstMessage: reachedFirst > 0,
        listeners: await listenerCensus(),
        errors: errorsSince(mark),
        report: await report(page),
      });
    }

    if (wants("concord-switch")) {
      console.log("▶ concord-switch (channel hopping, heap floor per round)");
      mark = errors.length;
      await page.goto(channelPath(1));
      await until(page, () => page.getByText("(#59)", { exact: false }).first().isVisible(), 90_000);
      await page.waitForTimeout(3000);
      const floors = [await heapFloorMB(cdp)];
      await resetCounters(page);
      const a = await metrics(cdp);
      const t = Date.now();
      const rounds = 4;
      const { hot } = await cpuProfile(async () => {
        for (let round = 0; round < rounds; round++) {
          for (let i = 1; i < concord.channelIds.length; i++) {
            await softNavigate(page, channelPath(i));
            await page.waitForTimeout(600);
          }
          floors.push(await heapFloorMB(cdp));
        }
      });
      const b = await metrics(cdp);
      save("concord-switch", {
        hot,
        switches: (concord.channelIds.length - 1) * rounds,
        cost: cost(a, b, (Date.now() - t) / 1000),
        heapFloorMBPerRound: floors,
        errors: errorsSince(mark),
        report: await report(page),
      });
    }
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
