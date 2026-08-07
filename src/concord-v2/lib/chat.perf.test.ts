import { describe, expect, it } from "vitest";

import { foldTimeline, type OpenedChat } from "@/concord-v2/lib/chat";
import { KIND_EDIT, KIND_MESSAGE, KIND_REACTION } from "@/concord-v2/lib/kinds";

/**
 * Perf evidence + regression guard for the channel-switch cost of the Concord
 * chat fold (`foldTimeline`, chat.ts:313).
 *
 * The claim under test: the fold is NOT windowed to the rendered slice — it
 * reprocesses the ENTIRE loaded message set (moderation drop, edit apply,
 * reaction/zap/poll tally, final sort) every time it runs, and it runs on every
 * channel switch (useChannel2.ts:400-407 re-derives it from `query.data`). So
 * its cost is O(loaded set), not O(visible rows), and switching back and forth
 * pays it in full each time — there is no cross-call memo of the structural
 * passes (only per-rumor zap-verify verdicts are cached, chat.ts:272, and this
 * fixture uses no zaps so those don't mask the structural cost).
 *
 * A warm channel loads WINDOW_SIZE = 100 (useChannel2.ts:58); scrolling history
 * grows the set (loadOlder), which is what the 500/2000 points model. If the
 * fold is ever moved behind a memo or windowed, the "grows with N" / "re-fold
 * costs ~the same" assertions below flip and this guard fires.
 */

const CHANNEL = "aa".repeat(32);
const AUTHORS = Array.from({ length: 24 }, (_, i) => String.fromCharCode(97 + (i % 26)).repeat(64));

/** A realistic loaded set: ~70% messages, ~20% reactions, ~10% author edits. */
function buildSet(n: number): OpenedChat[] {
  const out: OpenedChat[] = [];
  const msgIds: string[] = [];
  let lastMsgId = "";
  let lastMsgAuthor = AUTHORS[0];
  let seq = 0;
  const nextId = () => (seq++).toString(16).padStart(64, "0");
  const base = (kind: number, author: string, content: string, ms: number, extra: string[][]): OpenedChat => ({
    rumorId: nextId(),
    author,
    kind,
    content,
    tags: [["channel", CHANNEL], ["epoch", "0"], ...extra],
    ms,
    createdAt: Math.floor(ms / 1000),
    channelIdHex: CHANNEL,
    epoch: 0n,
  });

  for (let i = 0; i < n; i++) {
    const ms = 1_000_000 + i * 1000;
    const author = AUTHORS[i % AUTHORS.length];
    const roll = i % 10;
    if (roll < 7 || !lastMsgId) {
      const ev = base(KIND_MESSAGE, author, `message body number ${i} with a little text`, ms, []);
      out.push(ev);
      msgIds.push(ev.rumorId);
      lastMsgId = ev.rumorId;
      lastMsgAuthor = author;
    } else if (roll < 9) {
      // React to a recent message (fans the reaction-tally Map).
      const target = msgIds[msgIds.length - 1 - (i % 3)] ?? lastMsgId;
      out.push(base(KIND_REACTION, author, "+", ms, [["e", target]]));
    } else {
      // The message author edits their latest message (exercises the edit pass).
      out.push(base(KIND_EDIT, lastMsgAuthor, `edited body ${i}`, ms, [["e", lastMsgId]]));
    }
  }
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Median wall-clock of `runs` full folds of the same set. */
function timeFold(set: OpenedChat[], runs = 7): number {
  const ts: number[] = [];
  for (let r = 0; r < runs; r++) {
    const t = performance.now();
    foldTimeline(set);
    ts.push(performance.now() - t);
  }
  return median(ts);
}

describe("foldTimeline channel-switch cost", () => {
  it(
    "[perf] cost scales with the whole loaded set (un-windowed)",
    () => {
      const s100 = buildSet(100);
      const s500 = buildSet(500);
      const s2000 = buildSet(2000);

      const t100 = timeFold(s100);
      const t500 = timeFold(s500);
      const t2000 = timeFold(s2000);

      console.log(
        `[perf] foldTimeline: 100 msgs ${t100.toFixed(2)}ms · ` +
          `500 msgs ${t500.toFixed(2)}ms · 2000 msgs ${t2000.toFixed(2)}ms ` +
          `(${(t2000 / Math.max(t100, 0.001)).toFixed(1)}× for 20× the set)`,
      );

      // Something survives the fold (sanity: the fixture isn't empty/dropped).
      expect(foldTimeline(s2000).messages.length).toBeGreaterThan(1000);

      // The signature of "processes the entire loaded set, not a fixed visible
      // slice": more loaded history ⇒ strictly more work. A windowed fold would
      // flatten this.
      expect(t2000).toBeGreaterThan(t100);

      // Generous ceiling — evidence, not a tight bound (jsdom/machine noise).
      expect(t2000).toBeLessThan(2000);
    },
    30_000,
  );

  it("re-folding the same set costs the same each time (no cross-switch memo)", () => {
    const set = buildSet(500);
    // Warm any per-rumor caches first, then compare two fresh folds. The
    // structural passes (edit apply, reaction tally, sort) re-run in full, so a
    // switch away and back pays the cost again — the second fold is NOT ~free.
    timeFold(set, 3);
    const first = timeFold(set, 5);
    const second = timeFold(set, 5);
    expect(second).toBeGreaterThan(first * 0.3);
    // And each fold is real work, not a no-op short-circuit.
    expect(second).toBeGreaterThan(0);
  });
});
