/**
 * Flood clustering — the render-layer rule, at unit scale.
 *
 * `spamFlood.test.ts` exercises this against real sealed wraps and the actual
 * flood shapes; here the events are plain objects so the boundaries (thresholds,
 * ordering, what counts as a stranger) can be pinned one at a time.
 *
 * The property that matters most is the one a security reviewer will look for
 * and not find: nothing here can remove a message. Every assertion is about
 * which ids land in a display set.
 */

import { describe, expect, it } from "vitest";

import type { OpenedChat } from "@/concord/lib/chat";
import {
  FLOOD_COHORT_AUTHORS,
  FLOOD_COHORT_TAIL_MS,
  FLOOD_MIN_MESSAGES,
  FLOOD_WINDOW_MS,
  floodClusters,
  shapeKey,
} from "@/concord/lib/floodCluster";

const T0 = 1_700_000_000_000;

let seq = 0;
function msg(author: string, content: string, ms: number): OpenedChat {
  seq += 1;
  return {
    rumorId: `r${seq}`,
    author,
    kind: 9,
    content,
    tags: [],
    ms,
    createdAt: Math.floor(ms / 1000),
    channelIdHex: "ab".repeat(32),
    epoch: 0n,
  };
}

/** `n` messages, one per author unless `author` is fixed, `gapMs` apart. */
function burst(n: number, content: (i: number) => string, opts: { author?: string; gapMs?: number; from?: number } = {}) {
  const gap = opts.gapMs ?? 1000;
  const from = opts.from ?? T0;
  return Array.from({ length: n }, (_, i) =>
    msg(opts.author ?? `bot${i}`, content(i), from + i * gap),
  );
}

const sorted = (evs: OpenedChat[]) => [...evs].sort((a, b) => a.ms - b.ms);

describe("shapeKey", () => {
  it("collapses a per-copy nonce behind template scaffolding", () => {
    const a = shapeKey("SANTA CLAUS WAS>SANTA CLAUS 2025! 2zs5g9");
    expect(shapeKey("SANTA CLAUS WAS>SANTA CLAUS 2025! 4bts2a")).toBe(a);
    // The leak a composition-based rule has: an all-letter suffix.
    expect(shapeKey("SANTA CLAUS WAS>SANTA CLAUS 2025! abcdef")).toBe(a);
  });

  it("collapses digit-bearing tokens and URLs", () => {
    expect(shapeKey("visit https://a.example now")).toBe(shapeKey("visit https://b.example now"));
    expect(shapeKey("page 12 of 30")).toBe(shapeKey("page 44 of 91"));
  });

  it("normalizes case, whitespace and zero-width padding", () => {
    expect(shapeKey("  Hello   There ")).toBe("hello there");
    expect(shapeKey("hel\u200blo")).toBe("hello");
  });

  it("keeps unrelated sentences apart", () => {
    expect(shapeKey("morning all")).not.toBe(shapeKey("did the build go green?"));
    // No scaffolding, so an ordinary trailing token survives — this is what
    // stops `Reference: def456` and `Order ref: abc123` from sharing a bucket
    // with every other reference anyone posts.
    expect(shapeKey("reference: defghi")).not.toBe(shapeKey("reference: jklmno"));
  });

  it("is empty for content with nothing to repeat", () => {
    expect(shapeKey("   ")).toBe("");
    expect(shapeKey("")).toBe("");
  });
});

describe("floodClusters", () => {
  it("needs the full run length before it fires", () => {
    const under = burst(FLOOD_MIN_MESSAGES - 1, () => "same message");
    expect(floodClusters(sorted(under)).size).toBe(0);

    const at = burst(FLOOD_MIN_MESSAGES, () => "same message");
    expect(floodClusters(sorted(at)).size).toBe(FLOOD_MIN_MESSAGES);
  });

  it("needs the run inside one window", () => {
    // The same messages, spread just past the window, are a slow drip and not a
    // visual flood — nothing is on screen at once to collapse.
    const spread = burst(FLOOD_MIN_MESSAGES, () => "same message", {
      gapMs: Math.ceil(FLOOD_WINDOW_MS / (FLOOD_MIN_MESSAGES - 2)),
    });
    expect(floodClusters(sorted(spread)).size).toBe(0);
  });

  it("collapses one author repeating regardless of history", () => {
    const history = [msg("solo", "hello everyone", T0 - 86_400_000)];
    const hammer = burst(20, () => "buy now", { author: "solo", from: T0 });
    const flagged = floodClusters(sorted([...history, ...hammer]));
    expect(hammer.every((m) => flagged.has(m.rumorId))).toBe(true);
    expect(flagged.has(history[0].rumorId)).toBe(false);
  });

  it("collapses strangers arriving together", () => {
    const flood = burst(30, () => "same payload");
    expect(floodClusters(sorted(flood)).size).toBe(30);
  });

  it("leaves established authors saying the same thing", () => {
    // Each speaks once well before the window, then all repeat one phrase.
    const history = Array.from({ length: 12 }, (_, i) =>
      msg(`member${i}`, `distinct opener ${String.fromCharCode(97 + i)}`, T0 + i * 1000),
    );
    const echo = Array.from({ length: 12 }, (_, i) =>
      msg(`member${i}`, "gm", T0 + 600_000 + i * 1000),
    );
    const flagged = floodClusters(sorted([...history, ...echo]));
    expect(flagged.size).toBe(0);
  });

  it("still collapses established authors when there are only two of them", () => {
    // Two voices repeating is a flood however long they have been around; the
    // stranger test is not the only branch.
    const history = [msg("a", "hi", T0), msg("b", "hey", T0 + 1000)];
    const spam = Array.from({ length: 20 }, (_, i) =>
      msg(i % 2 === 0 ? "a" : "b", "same thing", T0 + 600_000 + i * 1000),
    );
    const flagged = floodClusters(sorted([...history, ...spam]));
    expect(spam.every((m) => flagged.has(m.rumorId))).toBe(true);
  });

  it("ignores empty and whitespace-only content", () => {
    const blanks = burst(30, () => "   ");
    expect(floodClusters(sorted(blanks)).size).toBe(0);
  });

  it("does not let one bucket's flood condemn another bucket", () => {
    const flood = burst(20, () => "spam payload", { from: T0 });
    const chat = Array.from({ length: 6 }, (_, i) =>
      msg(`person${i}`, `unique thought ${String.fromCharCode(97 + i)}`, T0 + i * 2000),
    );
    const flagged = floodClusters(sorted([...flood, ...chat]));
    expect(flood.every((m) => flagged.has(m.rumorId))).toBe(true);
    expect(chat.some((m) => flagged.has(m.rumorId))).toBe(false);
  });

  it("flags every message of an overlapping run exactly once", () => {
    // A long flood produces many overlapping qualifying windows; the marking
    // pointer must not skip the head of a later window nor re-walk the batch.
    const long = burst(200, () => "same message", { gapMs: 100 });
    const flagged = floodClusters(sorted(long));
    expect(flagged.size).toBe(200);
  });

  it("treats the opening of a batch as judgeable only by author count", () => {
    // A boundary worth knowing rather than discovering. "Stranger" means "had
    // not spoken before this window opened", so at the very first window of a
    // batch nobody has spoken before and everyone qualifies. A same-template
    // run of 8+ at the head of the loaded history therefore collapses — which
    // is a flood by every other measure, but note it is the one place the rule
    // has no history to reason from.
    const opening = burst(FLOOD_MIN_MESSAGES, () => "same message");
    expect(floodClusters(sorted(opening)).size).toBe(FLOOD_MIN_MESSAGES);

    // Give the same authors one earlier line each and they are established.
    const before = Array.from({ length: FLOOD_MIN_MESSAGES }, (_, i) =>
      msg(`bot${i}`, `opener ${String.fromCharCode(97 + i)}`, T0 - 600_000 + i * 1000),
    );
    expect(floodClusters(sorted([...before, ...opening])).size).toBe(0);
  });

  it("is cheap on a large ordinary timeline", () => {
    // Runs inside every fold, so a busy channel must not pay for it. Ordinary
    // chat spreads across many buckets, none of them dense in one window.
    const many = Array.from({ length: 20_000 }, (_, i) =>
      msg(`member${i % 200}`, `thoughts on subject ${String.fromCharCode(97 + (i % 50))} today`, T0 + i * 1000),
    );
    const started = performance.now();
    const flagged = floodClusters(many);
    expect(performance.now() - started).toBeLessThan(500);
    expect(flagged.size).toBe(0);
  });
});

/**
 * The campaign this file is shaped around, rebuilt from a live one: 15 keys,
 * ~150 messages, one hour, ~15 pitches rotated between them, and every copy
 * varying its amount, its domain and sometimes a name.
 *
 * Read this as the regression test for a rule that has already been evaded
 * once. Exact-template density saw 9 of 153 messages here, because no single
 * pitch was ever dense and the keys stopped being new after their first
 * message.
 */
const PITCHES = [
  "Earn $#AMT per day from home with this one simple trick. No experience needed: #URL",
  "Hey, check your DMs, I sent you something",
  "Free mint is live! Only #AMT spots left. Mint yours now: #URL",
  "[ALERT] Suspicious login detected on your account. Verify your wallet immediately or funds will be locked: #URL",
  "I made #AMT% in 3 weeks with this signals group. Join free today, spots limited: #URL",
  "This community is dead, everyone moved to the real server. Join us: #URL",
  "Mods are banning everyone who knows the truth. Screenshot this before it gets deleted: #URL",
  "Anyone else unable to withdraw? Support told me to use this official sync portal and it worked: #URL",
  "Hi, I'm #NAME from official support. We detected unusual activity on your account. Please verify here: #URL",
  "PEPE is about to pump. Insider news dropping in 1 hour, get in early: #URL",
  "Why is nobody talking about this? SOL staking at #AMT% APY, I've already withdrawn twice: #URL",
  "Congratulations! Your wallet was selected in the ETH airdrop snapshot. Claim #AMT ETH before it expires: #URL",
];
const DOMAINS = ["elon-giveaway", "pump-alerts", "wallet-sync", "verify-wallet", "prize-draw", "claim-portal"];
const NAMES = ["sarah", "cryptoking", "adminsupport", "jessica", "mike", "support_team"];

/** Deterministic PRNG — a fixture that flakes is worse than no fixture. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** `n` campaign messages from `keys` keys, spread over `spanMs`. */
function campaign(n: number, keys: number, spanMs: number, from = T0, seed = 7): OpenedChat[] {
  const rnd = lcg(seed);
  return Array.from({ length: n }, (_, i) => {
    const body = PITCHES[Math.floor(rnd() * PITCHES.length)]
      .replace("#AMT", String(100 + Math.floor(rnd() * 9000)))
      .replace("#URL", `https://${DOMAINS[Math.floor(rnd() * DOMAINS.length)]}.example.com`)
      .replace("#NAME", NAMES[Math.floor(rnd() * NAMES.length)]);
    return msg(`sybil${Math.floor(rnd() * keys)}`, body, from + Math.floor((i / n) * spanMs));
  });
}

describe("floodClusters — a rotating campaign", () => {
  it("folds the campaign the exact-template rule could not see", () => {
    const spam = campaign(150, 15, 58 * 60_000);
    const flagged = floodClusters(sorted(spam));
    const share = flagged.size / spam.length;
    expect(share).toBeGreaterThan(0.8);
  });

  it("still folds the second wave from keys that already spoke", () => {
    // The hole the stranger test alone had: newness is satisfied exactly once
    // per key, so a campaign that warms its keys up first was invisible.
    const first = campaign(60, 12, 15 * 60_000, T0, 3);
    const second = campaign(60, 12, 15 * 60_000, T0 + 3 * 3_600_000, 3);
    const flagged = floodClusters(sorted([...first, ...second]));
    const secondFlagged = second.filter((m) => flagged.has(m.rumorId)).length;
    const firstFlagged = first.filter((m) => flagged.has(m.rumorId)).length;
    expect(secondFlagged / second.length).toBeGreaterThan(0.7);
    // The point is not the exact share but that being seen before buys nothing:
    // the two waves are folded to within a rounding error of each other.
    expect(Math.abs(secondFlagged - firstFlagged)).toBeLessThanOrEqual(6);
  });

  it("merges a template family that only swaps a name", () => {
    // Four buckets under an exact-template rule; one campaign under this one.
    const evs = NAMES.slice(0, 4).flatMap((name, i) =>
      Array.from({ length: 2 }, (_, k) =>
        msg(
          `sybil${i}${k}`,
          `Hi, I'm ${name} from official support. We detected unusual activity on your account.`,
          T0 + (i * 2 + k) * 120_000,
        ),
      ),
    );
    expect(floodClusters(sorted(evs)).size).toBe(evs.length);
  });

  it("leaves the reader's own messages alone", () => {
    // Pasting a list line by line trips every density rule there is, and the
    // one thing a client must never do is eat what its user just typed.
    const mine = Array.from({ length: 12 }, (_, i) =>
      msg("me", `- step ${i + 1} of the migration plan we agreed on`, T0 + i * 20_000),
    );
    expect(floodClusters(sorted(mine), { self: "me" }).size).toBe(0);
    // …and without the hint, it is only more eager.
    expect(floodClusters(sorted(mine)).size).toBeGreaterThan(0);
  });

  it("leaves an album alone: link- and emoji-only posts have nothing to echo", () => {
    const album = Array.from({ length: 12 }, (_, i) =>
      msg("photographer", `https://media.example.com/holiday-${i}.jpg`, T0 + i * 15_000),
    );
    expect(floodClusters(sorted(album)).size).toBe(0);

    // Emoji from established members is the same: nothing to repeat.
    const regulars = Array.from({ length: 12 }, (_, i) =>
      msg(`fan${i}`, `opener ${String.fromCharCode(97 + i)}`, T0 - 3_600_000 + i * 1000),
    );
    const cheers = Array.from({ length: 12 }, (_, i) => msg(`fan${i}`, "🎉", T0 + i * 15_000));
    expect(floodClusters(sorted([...regulars, ...cheers])).size).toBe(0);

    // From twelve keys nobody has heard from before, though, the arrival rule
    // has an opinion the content rules cannot have — see the burst tests.
    expect(floodClusters(sorted(cheers)).size).toBeGreaterThan(0);
  });

  it("leaves short phrases that a room genuinely shares", () => {
    for (const phrase of ["gm", "+1", "same here", "lol", "thanks for the update"]) {
      const evs = Array.from({ length: 10 }, (_, i) =>
        msg(`member${i}`, phrase, T0 + 600_000 + i * 120_000),
      );
      // Give everyone history first, so only the echo rule is in play. The
      // openers must be genuinely DIFFERENT sentences: ten copies of one
      // sentence differing by a number are one template, and the density rule
      // would (rightly) fold those instead.
      const before = Array.from({ length: 10 }, (_, i) =>
        msg(`member${i}`, `opener ${String.fromCharCode(97 + i)}`, T0 + i * 1000),
      );
      expect(floodClusters(sorted([...before, ...evs])).size).toBe(0);
    }
  });

  it("holds a one-word chorus to a much higher bar", () => {
    // The strongest false positive the density rule had: a dozen newcomers
    // saying `gm` are dense, identical, and none of them has spoken before,
    // which is every condition the rule tests. A single word is a chorus, not
    // a template.
    const gm = Array.from({ length: 12 }, (_, i) => msg(`newcomer${i}`, "gm", T0 + i * 10_000));
    expect(floodClusters(sorted(gm)).size).toBe(0);
    const lol = Array.from({ length: 12 }, (_, i) => msg(i % 2 ? "a" : "b", "lol", T0 + i * 10_000));
    expect(floodClusters(sorted(lol)).size).toBe(0);

    // Higher, not gone: sixty in half a minute is a wall whatever the word is.
    const wall = Array.from({ length: 60 }, (_, i) => msg(`newcomer${i}`, "gm", T0 + i * 500));
    expect(floodClusters(sorted(wall)).size).toBe(60);

    // Two words is enough to be judged as an ordinary template again.
    const pitch = Array.from({ length: 12 }, (_, i) => msg(i % 2 ? "a" : "b", "buy now", T0 + i * 10_000));
    expect(floodClusters(sorted(pitch)).size).toBe(12);
  });

  it("wants a pitch SPREAD across keys, not two colleagues agreeing", () => {
    // Two people who both say `just pushed the fix` are a team with one job,
    // and no number of repetitions makes them a campaign — the echo rule is
    // about one message living on many keys, which is what a sybil set is for.
    const line = "just pushed the fix, it should be live shortly";
    const pair = Array.from({ length: 8 }, (_, i) => msg(i % 2 ? "ana" : "bo", line, T0 + i * 60_000));
    expect(floodClusters(sorted(pair)).size).toBe(0);

    // A third key saying the same sentence is what turns it into an echo. In
    // the live campaign every pitch sat on five to eight keys.
    const spread = Array.from({ length: 8 }, (_, i) => msg(`key${i % 4}`, line, T0 + i * 60_000));
    expect(floodClusters(sorted(spread)).size).toBe(spread.length);
  });

  it("folds a crowd of first-time keys arriving at once, whatever they say", () => {
    // The cheapest flood to mint and the one no content rule can see: one
    // message per key, a different pitch each time. Twenty-two such keys is
    // what the live channel turned into.
    const room = [
      msg("regular", "morning all", T0 - 600_000),
      msg("regular2", "did the build go green?", T0 - 300_000),
    ];
    const swarm = Array.from({ length: 20 }, (_, i) =>
      msg(`key${i}`, `pitch number ${String.fromCharCode(97 + i)} with a link https://x${i}.example`, T0 + i * 5000),
    );
    const flagged = floodClusters(sorted([...room, ...swarm]));
    expect(swarm.filter((m) => flagged.has(m.rumorId)).length).toBeGreaterThan(15);
    // The people who were already talking keep their rows.
    expect(room.some((m) => flagged.has(m.rumorId))).toBe(false);
  });

  it("keeps a regular's rows while the swarm around them folds", () => {
    const room = [msg("regular", "morning all", T0 - 600_000)];
    const swarm = Array.from({ length: 20 }, (_, i) =>
      msg(`key${i}`, `pitch ${String.fromCharCode(97 + i)} https://x${i}.example`, T0 + i * 5000),
    );
    const replies = [msg("regular", "what is going on in here", T0 + 30_000), msg("regular", "mods?", T0 + 60_000)];
    const flagged = floodClusters(sorted([...room, ...swarm, ...replies]));
    expect(replies.some((m) => flagged.has(m.rumorId))).toBe(false);
  });

  it("says nothing about the head of a loaded batch", () => {
    // At the start of the loaded history nobody has spoken before, so every
    // author reads as new. Folding there would eat the oldest screenful of
    // every channel — the rule requires history to exist before the window.
    const head = Array.from({ length: 20 }, (_, i) =>
      msg(`member${i}`, `a distinct opening remark ${String.fromCharCode(97 + i)}`, T0 + i * 5000),
    );
    expect(floodClusters(sorted(head)).size).toBe(0);
  });

  it("needs two authors before an echo counts", () => {
    // One key repeating is the density rule's business, and its window is
    // short on purpose: a person re-posting their own long sentence four times
    // across an hour is not a flood.
    const solo = Array.from({ length: 6 }, (_, i) =>
      msg("chatty", "here is the agenda for the meeting later today, please read it", T0 + i * 600_000),
    );
    expect(floodClusters(sorted(solo)).size).toBe(0);
  });
});

/**
 * The cohort rule — the one that reads no content at all.
 *
 * Every fixture here uses content that is UNIQUE per message and too short to
 * be echo-eligible, so nothing in the file's three content rules can fire and
 * what is being measured is only the cohort logic. That is also the attack it
 * exists for: a slot-filling generator emits no two identical messages.
 */
describe("floodClusters — a cohort that drowns the channel", () => {
  /** Past FLOOD_COHORT_PRECEDENT_MS, so the founder is precedent for the cohort. */
  const AFTER_HISTORY = 700_000;
  /** Distinct, wordless-to-the-content-rules filler. */
  const uniq = (i: number, j: number) =>
    `hello ${String.fromCharCode(97 + i)}${String.fromCharCode(97 + j)}zz`;

  /** A founder, then `authors` keys arriving 90s apart posting `each` messages 60s apart. */
  function conveyor(authors: number, each: number, from = T0 + AFTER_HISTORY) {
    const out = [msg("founder", "morning everyone", T0)];
    for (let i = 0; i < authors; i++) {
      for (let j = 0; j < each; j++) {
        out.push(msg(`key${i}`, uniq(i, j), from + i * 90_000 + j * 60_000));
      }
    }
    return sorted(out);
  }

  it("folds a conveyor of keys whose every message is different", () => {
    const evs = conveyor(10, 5);
    const flagged = floodClusters(evs);
    // Every cohort message, and never the founder's.
    expect(flagged.size).toBe(50);
    expect(evs.filter((e) => e.author === "founder").every((e) => !flagged.has(e.rumorId))).toBe(true);
  });

  it("leaves an influx alone while the regulars are still talking", () => {
    // The same ten newcomers, but the room they walked into is busy. Newcomers
    // are 50 of 74 messages — under FLOOD_COHORT_SHARE — so this reads as
    // growth, which is what an invite posted somewhere busy actually looks like.
    const evs = conveyor(10, 5);
    for (let r = 0; r < 3; r++) {
      for (let k = 0; k < 8; k++) {
        evs.push(msg(`reg${r}`, `regular chatter ${r} ${String.fromCharCode(97 + k)}`, T0));
        evs.push(msg(`reg${r}`, `still here ${r} ${String.fromCharCode(97 + k)}`, T0 + AFTER_HISTORY + k * 100_000));
      }
    }
    expect(floodClusters(sorted(evs)).size).toBe(0);
  });

  it("says nothing when the channel has no history to be new relative to", () => {
    // The same crowd, arriving in the channel's opening minutes. Everyone is
    // new because the channel is new; there is no cohort, only a launch.
    expect(floodClusters(conveyor(10, 5, T0 + 60_000)).size).toBe(0);
  });

  it("needs a crowd, not a handful of newcomers", () => {
    expect(floodClusters(conveyor(FLOOD_COHORT_AUTHORS - 1, 5)).size).toBe(0);
  });

  /** Three keys, nine messages each, interleaved `gapMs` apart. */
  function trio(gapMs: number) {
    const out = [msg("founder", "morning everyone", T0)];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 9; j++) {
        out.push(msg(`key${i}`, uniq(i, j), T0 + AFTER_HISTORY + (j * 3 + i) * gapMs));
      }
    }
    return sorted(out);
  }

  it("folds three keys hammering, long before an eighth would arrive", () => {
    // The live campaign as it looked 78 seconds in: share 1.00, ~19 messages a
    // minute, three keys so far, in a channel that existed before them. Waiting
    // for breadth cost four more minutes and sixty more messages while the
    // flood was already unmistakable.
    expect(floodClusters(trio(3_400)).size).toBe(27);
  });

  it("leaves the same three keys alone at conversation pace", () => {
    // Identical in every other respect — same keys, same arrival, same share,
    // same message count. Nine messages each across half an hour is people
    // talking, and three is far short of what breadth alone carries.
    expect(floodClusters(trio(70_000)).size).toBe(0);
  });

  it("keeps the row of someone who arrives mid-flood and says one thing", () => {
    // THE false-positive that matters: a real person follows an invite into a
    // channel under attack. They arrive inside the cohort's window and cannot
    // be told from it by arrival alone — but they have flooded nothing.
    const evs = conveyor(10, 5);
    const joiner = msg("joiner", "hi all, glad to be here", T0 + AFTER_HISTORY + 300_000);
    evs.push(joiner);
    expect(floodClusters(sorted(evs)).has(joiner.rumorId)).toBe(false);
  });

  it("releases once the cohort goes quiet", () => {
    // The wave ends at FLOOD_COHORT_TAIL_MS of silence, so a key that comes
    // back later to say something ordinary is outside it and renders.
    const evs = conveyor(10, 5);
    const later = Array.from({ length: 5 }, (_, i) =>
      msg(`key${i}`, `following up on that ${String.fromCharCode(97 + i)}`, T0 + AFTER_HISTORY + FLOOD_COHORT_TAIL_MS + 3_600_000 + i * 60_000),
    );
    const flagged = floodClusters(sorted([...evs, ...later]));
    expect(later.every((e) => !flagged.has(e.rumorId))).toBe(true);
  });

  it("never folds the reading user's own messages", () => {
    const evs = conveyor(10, 5);
    const flagged = floodClusters(evs, { self: "key3" });
    expect(evs.filter((e) => e.author === "key3").every((e) => !flagged.has(e.rumorId))).toBe(true);
  });
});
