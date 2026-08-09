/**
 * Visual flood suppression for the Chat Plane.
 *
 * Chat write access is key possession (CORD-04 §1) and an invite link is
 * unlimited-use, so a public community's channel can be filled by anyone who
 * ever opened the link — with one key hammering, a handful sharing the load, or
 * a fresh key per message. This module answers only the RENDER question: which
 * messages are part of a wall of noise and should fold into a single row.
 *
 * It is not a security boundary and must never be used as one. Nothing here
 * drops a message, refuses a write, or feeds a moderation decision: the Banlist
 * remains the only author-identity drop an honest client performs (see
 * `ChatModeration` in `chat.ts`), and a heuristic must not quietly become the
 * second one. Being wrong here costs a collapsed row the reader can expand.
 *
 * The rule buckets by CONTENT first and only then looks at who sent it, which
 * is what lets one test cover every flood shape: bucketing by author would need
 * a different rule for 1×100 than for 100×1, and the second is free to mint.
 * An author count is therefore a description of the flood, not its trigger.
 *
 * ## What a real flood looked like
 *
 * A live campaign (15 keys, 153 messages, one hour) is the fixture this file
 * is shaped around, and it defeated an exact-template rule completely:
 *
 * - **The template ROTATES.** ~15 different pitches, each posted 3-14 times, so
 *   no single template ever reached a dense-window threshold. Hence
 *   {@link normalizeTokens} + near-duplicate clustering: `hi, i'm sarah from
 *   official support…` and `hi, i'm cryptoking from official support…` are one
 *   campaign, and only a similarity measure says so.
 * - **The keys speak more than once.** Any "author who has not spoken before
 *   this window" test is satisfied for the FIRST burst and never again — the
 *   second wave from the same keys looked established. Hence the cross-author
 *   echo rule below, which needs no notion of newness at all.
 *
 * So there are two independent rules, and a message folds if EITHER fires:
 *
 * 1. **Density** — one template repeated {@link FLOOD_MIN_MESSAGES} times
 *    inside {@link FLOOD_WINDOW_MS}, by at most two authors or by authors none
 *    of whom had spoken before the window opened. This is the one-key hammer
 *    and the all-at-once swarm.
 * 2. **Echo** — a substantial template posted {@link FLOOD_ECHO_MIN} times
 *    across {@link FLOOD_ECHO_MIN_AUTHORS} or more keys inside
 *    {@link FLOOD_ECHO_WINDOW_MS}. People converge on short phrases (`gm`,
 *    `+1`, `lol`) constantly and on eight-word sentences essentially never,
 *    which is why the rule is gated on length; and one pitch on many keys is
 *    what a sybil set is FOR, which is why it is gated on spread.
 */

import type { OpenedChat } from "@/concord/lib/chat";

/** Messages sharing a template within one window before it reads as a flood. */
export const FLOOD_MIN_MESSAGES = 8;
/** How close together those messages must fall. */
export const FLOOD_WINDOW_MS = 300_000;
/**
 * A flood carried by one or two keys is the same nuisance whether or not those
 * keys are known, so density alone condemns it past this author count. Above
 * it, the authors must ALL be strangers — a dozen regulars converging on one
 * phrasing is a conversation.
 */
export const FLOOD_MAX_FAMILIAR_AUTHORS = 2;
/**
 * Words a template needs before the density rule judges it at the ordinary
 * threshold; below it, {@link FLOOD_SHORT_FACTOR} times as many are required.
 *
 * One word is a chorus, not a template. A dozen newcomers saying `gm` over a
 * couple of minutes satisfies every density condition there is — dense,
 * identical, nobody has spoken before — and folding that hides the friendliest
 * thing a community does. Sixty of them inside thirty seconds is a wall
 * whatever the word is, so the bar rises rather than disappearing.
 */
export const FLOOD_MIN_WORDS = 2;
/** How much denser a sub-{@link FLOOD_MIN_WORDS} template must be to fold. */
export const FLOOD_SHORT_FACTOR = 3;

/** Copies of one substantial template, from ≥2 authors, before it reads as an echo. */
export const FLOOD_ECHO_MIN = 4;
/**
 * Distinct keys a template must be spread across before it reads as a campaign.
 *
 * Spreading ONE pitch across MANY keys is the whole purpose of a sybil set, and
 * it is what an honest repetition never does: two colleagues who both say
 * `just pushed the fix, should be live shortly` are a team with one job, and no
 * count of repetitions makes them a campaign. The observed flood put each pitch
 * on 7-9 keys.
 */
export const FLOOD_ECHO_MIN_AUTHORS = 3;
/** The echo rule's window — long, because a rotating campaign is not dense. */
export const FLOOD_ECHO_WINDOW_MS = 3_600_000;
/**
 * Words a template needs before the echo rule will look at it.
 *
 * The whole safety of that rule lives here, and the number is measured rather
 * than chosen: every template in the observed campaign ran 8-13 words
 * (`hey, check your dms, i sent you something` is the shortest), while the
 * phrases people genuinely repeat at each other — `gm`, `+1`, `same here`,
 * `thoughts on subject a today` — are short. Placeholders (`@` for a URL, `#`
 * for a number) don't count, so rotating the domain or the dollar amount buys
 * a spammer no length.
 *
 * A pitch carrying a LINK is held to a lower bar, because that is the shape
 * whose whole point is to be clicked and whose honest twin (four people
 * posting the identical sentence plus a URL within an hour) is vanishingly
 * rare. It is still a template match, not a URL match: the campaign rotated
 * domains per message.
 */
export const FLOOD_ECHO_MIN_WORDS = 8;
/** The lower bar for a template that carries a link. */
export const FLOOD_ECHO_MIN_WORDS_LINKED = 5;
/** Token overlap at which two templates are treated as one campaign. */
export const FLOOD_SIMILARITY = 0.6;

export interface FloodOptions {
  minMessages?: number;
  windowMs?: number;
  echoMin?: number;
  echoWindowMs?: number;
  /**
   * The reading user's pubkey. Their own messages are never folded: a person
   * pasting a list line by line trips every density rule there is, and hiding
   * what someone just typed reads as the client having eaten it.
   */
  self?: string;
}

const URL_RUN = /https?:\/\/\S+/g;
const TRAILING_NONCE = /([>!])\s*[a-z0-9]{4,9}$/;
const DIGIT_TOKEN = /[\p{L}\p{N}]*\p{N}[\p{L}\p{N}]*/gu;
const INVISIBLE = /[\u200b-\u200f\u2060\ufeff]/g;
/** Words, in any script. Emoji and punctuation are deliberately not words. */
const WORD = /[\p{L}][\p{L}\p{N}_]*/gu;

/**
 * A template fingerprint: what two copies of one broadcast share once the parts
 * that vary per copy are collapsed.
 *
 * The trailing nonce is found POSITIONALLY, by the `>` / `!` scaffolding the
 * observed campaigns put in front of it, rather than by looking random. Roughly
 * one base36 suffix in seven is all letters, so a composition test leaks about
 * that fraction of a campaign; widening it to "few vowels" starts eating words
 * like `thanks`.
 */
export function shapeKey(content: string): string {
  return content
    .toLowerCase()
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(URL_RUN, "@")
    .replace(TRAILING_NONCE, "$1#")
    .replace(DIGIT_TOKEN, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The words of a template, for the similarity measure and the echo rule's
 * length gate. Placeholders are already `@`/`#` by then, and neither is a word,
 * so a message that is nothing but a link or a photo has NO words — which is
 * what keeps a shared album out of the echo rule and out of the density rule
 * both. (A link-only flood is left to the Banlist; it is the one flood shape
 * this file deliberately declines to guess at, because the honest version of it
 * is someone posting ten holiday pictures.)
 */
export function normalizeTokens(shape: string): string[] {
  return shape.match(WORD) ?? [];
}

/** One template and every message that shares it. */
interface Bucket {
  shape: string;
  words: Set<string>;
  wordCount: number;
  linked: boolean;
  idx: number[];
}

/** Is this template substantial enough for the echo rule to judge it? */
function echoEligible(wordCount: number, linked: boolean): boolean {
  return wordCount >= (linked ? FLOOD_ECHO_MIN_WORDS_LINKED : FLOOD_ECHO_MIN_WORDS);
}

/** Jaccard overlap of two token sets. */
function similarity(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const t of small) if (large.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Document frequency above which a word is useless for finding candidates.
 * `the` appears in every bucket; indexing it would make every message a
 * candidate for every other and turn the merge into an O(n²) scan.
 */
const DF_CAP = 64;
/** Most candidate buckets one bucket will be compared against. */
const CANDIDATE_CAP = 48;

/**
 * Merge near-duplicate buckets into campaigns, returning a parent array
 * (union-find roots) over `buckets`.
 *
 * Only buckets long enough for the echo rule take part: a campaign is what we
 * are trying to see through, and short templates are exactly the ones where
 * "similar" stops meaning "the same message" (`gm all` vs `gm alice`).
 */
function mergeSimilar(buckets: Bucket[]): number[] {
  const parent = buckets.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const union = (a: number, b: number) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  const eligible = buckets
    .map((_, i) => i)
    .filter((i) => echoEligible(buckets[i].wordCount, buckets[i].linked));
  if (eligible.length < 2) return parent;

  const df = new Map<string, number>();
  for (const i of eligible) for (const w of buckets[i].words) df.set(w, (df.get(w) ?? 0) + 1);

  const index = new Map<string, number[]>();
  for (const i of eligible) {
    for (const w of buckets[i].words) {
      if ((df.get(w) ?? 0) > DF_CAP) continue;
      let list = index.get(w);
      if (!list) index.set(w, (list = []));
      list.push(i);
    }
  }

  for (const i of eligible) {
    const seen = new Map<number, number>();
    for (const w of buckets[i].words) {
      for (const j of index.get(w) ?? []) {
        if (j >= i) continue; // each pair once
        seen.set(j, (seen.get(j) ?? 0) + 1);
      }
    }
    // Most shared rare words first: the best candidates, and the cap then bites
    // on the ones that were never going to clear the threshold anyway.
    const candidates = [...seen.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, CANDIDATE_CAP);
    for (const [j] of candidates) {
      if (find(i) === find(j)) continue;
      if (similarity(buckets[i].words, buckets[j].words) >= FLOOD_SIMILARITY) union(i, j);
    }
  }
  return parent;
}

/** Per-message normalization, memoized on the row itself (folds re-run often). */
const normCache = new WeakMap<OpenedChat, { shape: string; words: string[] }>();
function normalize(ev: OpenedChat): { shape: string; words: string[] } {
  let n = normCache.get(ev);
  if (!n) {
    const shape = shapeKey(ev.content);
    normCache.set(ev, (n = { shape, words: normalizeTokens(shape) }));
  }
  return n;
}

/**
 * The rumor ids belonging to a visual flood.
 *
 * `messages` is expected in ms order (what `foldTimeline` returns). An author is
 * a STRANGER to a window when their earliest message in this timeline falls
 * inside it — they had not spoken before it opened. That is deliberately
 * relative rather than an absolute age: any fixed "must have N hours of
 * history" makes the opening messages of a channel unjudgeable, since at the
 * start of a batch nobody has history and everyone reads as new. It is also
 * only half the rule, because it is satisfied exactly once per key; the echo
 * rule is what still sees the second wave.
 *
 * The whole signal is derived from the batch, so this needs no store read, no
 * roster, and no membership state synced first.
 */
export function floodClusters(messages: readonly OpenedChat[], opts: FloodOptions = {}): Set<string> {
  const minMessages = opts.minMessages ?? FLOOD_MIN_MESSAGES;
  const windowMs = opts.windowMs ?? FLOOD_WINDOW_MS;
  const echoMin = opts.echoMin ?? FLOOD_ECHO_MIN;
  const echoWindowMs = opts.echoWindowMs ?? FLOOD_ECHO_WINDOW_MS;

  const flagged = new Set<string>();
  if (messages.length < Math.min(minMessages, echoMin)) return flagged;

  // First-seen is over EVERY message, the reader's own included: what it
  // answers is "had this key spoken yet", which is not a question about
  // whose timeline it is.
  const firstSeen = new Map<string, number>();
  for (const ev of messages) {
    const seen = firstSeen.get(ev.author);
    if (seen === undefined || ev.ms < seen) firstSeen.set(ev.author, ev.ms);
  }

  const byShape = new Map<string, Bucket>();
  for (let i = 0; i < messages.length; i++) {
    const ev = messages[i];
    if (opts.self !== undefined && ev.author === opts.self) continue;
    const { shape, words } = normalize(ev);
    // A shape with no WORDS in it is a message with nothing to repeat: an
    // attachment, a bare link, a row of emoji. Twelve of those in a row is
    // someone sharing an album, and the shape they share is the placeholder
    // this file put there — so neither rule may judge them. It leaves a
    // link-only flood visible, which is the Banlist's problem and not a
    // heuristic's: the honest version of that pattern is too common and too
    // valuable to fold.
    if (!shape || words.length === 0) continue;
    let bucket = byShape.get(shape);
    if (!bucket) {
      byShape.set(
        shape,
        (bucket = {
          shape,
          words: new Set(words),
          wordCount: words.length,
          linked: shape.includes("@"),
          idx: [],
        }),
      );
    }
    bucket.idx.push(i);
  }
  const buckets = [...byShape.values()];

  // Campaigns: near-duplicate templates folded together, so rotating the pitch
  // (or just the fake support agent's name) doesn't split one flood into
  // fifteen innocent-looking buckets.
  const parent = mergeSimilar(buckets);
  const campaigns = new Map<number, number[]>();
  for (let b = 0; b < buckets.length; b++) {
    let root = b;
    while (parent[root] !== root) root = parent[root];
    const list = campaigns.get(root);
    if (list) list.push(b);
    else campaigns.set(root, [b]);
  }

  for (const members of campaigns.values()) {
    // Message indices ascend within a bucket, so a merged campaign only needs a
    // sort when it actually merged something.
    let idx = buckets[members[0]].idx;
    if (members.length > 1) {
      idx = members.flatMap((b) => buckets[b].idx).sort((a, b) => a - b);
    }
    const short = members.every((b) => buckets[b].wordCount < FLOOD_MIN_WORDS);
    markDensity(
      messages,
      idx,
      short ? minMessages * FLOOD_SHORT_FACTOR : minMessages,
      windowMs,
      firstSeen,
      flagged,
    );
    // A campaign is echo-eligible when any of its templates is: the merge only
    // ever joins templates that were each eligible on their own.
    if (members.some((b) => echoEligible(buckets[b].wordCount, buckets[b].linked))) {
      markEcho(messages, idx, echoMin, echoWindowMs, flagged);
    }
  }
  markArrivalBurst(messages, firstSeen, flagged, opts.self);
  sweepParticipants(messages, flagged, opts.self);
  return flagged;
}

/** Messages by first-time keys inside {@link FLOOD_BURST_WINDOW_MS} to read as an arrival. */
export const FLOOD_BURST_MIN = 8;
/** …spread across at least this many of them. */
export const FLOOD_BURST_AUTHORS = 6;
/** Deliberately tighter than the density window: this is a burst, not a trend. */
export const FLOOD_BURST_WINDOW_MS = 120_000;

/**
 * Rule 3: a crowd of keys that have never spoken before, arriving at once.
 *
 * The shape content clustering cannot see, and the cheapest one to mint: ONE
 * message per key, each a different pitch. No template repeats, so no bucket
 * is ever dense and no pitch is ever echoed — the live channel went to
 * twenty-two keys with one message each, and the content rules folded eight of
 * twenty-five. What is left to notice is the arrival itself.
 *
 * Two things keep this off honest readers. It only ever folds the FIRST-TIMERS
 * in the window, so a regular talking through the wave keeps their row; and it
 * needs history to exist before the window at all, because at the head of a
 * loaded batch nobody has spoken yet and everyone reads as new — that boundary
 * would otherwise fold the oldest screenful of every channel.
 *
 * A genuine influx — an invite posted somewhere busy — folds too. That is the
 * accepted cost of the whole file: it is one click, and the alternative is a
 * rule that guesses at intent.
 */
function markArrivalBurst(
  messages: readonly OpenedChat[],
  firstSeen: Map<string, number>,
  flagged: Set<string>,
  self: string | undefined,
): void {
  const lastSeen = new Map<string, number>();
  for (const ev of messages) lastSeen.set(ev.author, ev.ms);

  // A key's first message, by index. `firstIdx[i] === i` marks the message that
  // introduced its author — so counting those inside the window counts the
  // keys that arrived during it, incrementally, without a per-position Set.
  const introduces = new Uint8Array(messages.length);
  const seen = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].author === self || seen.has(messages[i].author)) continue;
    seen.add(messages[i].author);
    introduces[i] = 1;
  }

  let lo = 0;
  let arrivals = 0;
  for (let hi = 0; hi < messages.length; hi++) {
    arrivals += introduces[hi];
    while (messages[hi].ms - messages[lo].ms > FLOOD_BURST_WINDOW_MS) arrivals -= introduces[lo++];
    // Nothing before the window means no established voice to be new relative
    // to — the head of the batch, where this rule has nothing to say.
    if (lo === 0) continue;
    // Cheap necessary condition, false for essentially every window of an
    // ordinary channel, which is what keeps this pass linear.
    if (arrivals < FLOOD_BURST_AUTHORS) continue;

    const from = messages[lo].ms;
    const to = messages[hi].ms;
    /**
     * A key whose ENTIRE presence in this timeline is inside the window: it
     * arrived, spoke, and was never heard from again.
     *
     * "New" alone is not enough, and the 20 000-message fixture is why — at
     * the head of any loaded batch every author is speaking for the first
     * time, and a rule that only asked about arrival folded the first minutes
     * of an ordinary channel. Someone who arrives and stays is a member; the
     * shape being folded here is the burner key.
     */
    const burner = (a: string) => a !== self && (firstSeen.get(a) ?? 0) >= from && (lastSeen.get(a) ?? 0) <= to;

    let burners = 0;
    for (let i = lo; i <= hi; i++) if (burner(messages[i].author)) burners++;
    if (burners < FLOOD_BURST_MIN) continue;

    for (let i = lo; i <= hi; i++) if (burner(messages[i].author)) flagged.add(messages[i].rumorId);
  }
}

/**
 * A key that carried this much of a flood is folded for the whole wave — every
 * message of theirs between their first and last flood message, whatever it
 * says.
 *
 * This is the one author-shaped rule in the file, and it is what makes the
 * fold usable rather than merely correct. A campaign's every-15th message is
 * an off-template one-off (a bare link, an `[ALERT]` nobody else reposted),
 * and each one splits the wall into another row: 138 live messages folded by
 * content alone still rendered as a dozen separate notices with slivers of
 * spam between them, which is the shape a reader experiences as "the client
 * did nothing". Once a key has spent this many messages on a campaign, its
 * off-template ones are the same wave.
 *
 * It is still a DISPLAY fold, and the wave's edges are its own messages: the
 * key is not muted, nothing before or after the wave is touched, and one click
 * shows all of it. An author-identity DROP remains the Banlist's alone.
 */
export const FLOOD_AUTHOR_MESSAGES = 4;

/**
 * Fold the rest of what a flood's participants said during their own wave.
 *
 * The wave is bounded by each key's own first and last flagged message, so a
 * spammer who returns tomorrow to say something ordinary is outside it.
 */
function sweepParticipants(
  messages: readonly OpenedChat[],
  flagged: Set<string>,
  self: string | undefined,
): void {
  if (flagged.size === 0) return;
  const span = new Map<string, { lo: number; hi: number; n: number }>();
  for (const ev of messages) {
    if (!flagged.has(ev.rumorId)) continue;
    const cur = span.get(ev.author);
    if (!cur) span.set(ev.author, { lo: ev.ms, hi: ev.ms, n: 1 });
    else {
      cur.hi = ev.ms;
      cur.n++;
    }
  }
  for (const [author, s] of span) if (s.n < FLOOD_AUTHOR_MESSAGES) span.delete(author);
  if (span.size === 0) return;
  for (const ev of messages) {
    if (ev.author === self || flagged.has(ev.rumorId)) continue;
    const s = span.get(ev.author);
    if (s && ev.ms >= s.lo && ev.ms <= s.hi) flagged.add(ev.rumorId);
  }
}

/**
 * Rule 1: one template, {@link FLOOD_MIN_MESSAGES} copies inside one window,
 * carried by at most two authors or by authors who had not spoken before.
 */
function markDensity(
  messages: readonly OpenedChat[],
  idx: readonly number[],
  minMessages: number,
  windowMs: number,
  firstSeen: Map<string, number>,
  flagged: Set<string>,
): void {
  if (idx.length < minMessages) return;
  let lo = 0;
  // Every id below this index is already flagged; marking is O(n) per campaign
  // rather than O(n²) across overlapping windows.
  let marked = 0;
  for (let hi = 0; hi < idx.length; hi++) {
    while (messages[idx[hi]].ms - messages[idx[lo]].ms > windowMs) lo++;
    if (hi - lo + 1 < minMessages) continue;

    const windowStart = messages[idx[lo]].ms;
    const authors = new Set<string>();
    let allStrangers = true;
    for (let i = lo; i <= hi; i++) {
      const author = messages[idx[i]].author;
      authors.add(author);
      if (allStrangers && (firstSeen.get(author) ?? windowStart) < windowStart) allStrangers = false;
    }
    if (!allStrangers && authors.size > FLOOD_MAX_FAMILIAR_AUTHORS) continue;

    for (let i = Math.max(lo, marked); i <= hi; i++) flagged.add(messages[idx[i]].rumorId);
    marked = hi + 1;
  }
}

/**
 * Rule 2: the same substantial template from two or more different authors,
 * {@link FLOOD_ECHO_MIN} times inside a long window.
 *
 * No density and no newness — this is the rule that survives a campaign that
 * paces itself, rotates its pitch, and warms its keys up first. What it costs
 * is that a genuinely shared long phrase (a pinned announcement everyone
 * re-posts) folds; what it buys is that copying the same sentence from a
 * second key stops being free.
 */
function markEcho(
  messages: readonly OpenedChat[],
  idx: readonly number[],
  echoMin: number,
  echoWindowMs: number,
  flagged: Set<string>,
): void {
  if (idx.length < echoMin) return;
  let lo = 0;
  let marked = 0;
  for (let hi = 0; hi < idx.length; hi++) {
    while (messages[idx[hi]].ms - messages[idx[lo]].ms > echoWindowMs) lo++;
    if (hi - lo + 1 < echoMin) continue;

    const authors = new Set<string>();
    for (let i = lo; i <= hi; i++) authors.add(messages[idx[i]].author);
    if (authors.size < FLOOD_ECHO_MIN_AUTHORS) continue;

    for (let i = Math.max(lo, marked); i <= hi; i++) flagged.add(messages[idx[i]].rumorId);
    marked = hi + 1;
  }
}
