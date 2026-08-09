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
 * The shape rules bucket by CONTENT first and only then look at who sent it,
 * which is what lets one test cover every flood shape: bucketing by author
 * would need a different rule for 1×100 than for 100×1, and the second is free
 * to mint. For those rules an author count is a description of the flood, not
 * its trigger. The trust rule (6) is the deliberate exception — it triggers on
 * WHO, because who-the-reader-trusts is the one input a flood cannot mint — and
 * it only ever spares, never newly condemns beyond the drown rule it gates.
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
 * A message folds if ANY of the rules below fires. The first five read the
 * flood's SHAPE — its content, arrival and pace — and each closes a gap the
 * previous one left:
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
 * 3. **Arrival burst** ({@link markArrivalBurst}) — a crowd of first-time keys
 *    arriving at once, each speaking once and vanishing.
 * 4. **Cohort** ({@link markCohortFlood}) — a crowd that arrived together and
 *    then drowned the channel, content ignored.
 * 5. **Gibberish** ({@link markGibberish}) — one key spending its messages on
 *    low-originality noise (`ggg`, room-foreign single words).
 *
 * ## Why shape is not enough, and what replaces it
 *
 * Every shape rule is an arms race the flood can win by changing shape: rotate
 * the pitch (density), post from one key (echo), warm the keys first (arrival,
 * cohort), write fluent sentences (gibberish). The end state, observed live, is
 * two or three ESTABLISHED keys taking turns posting unique, grammatical spam
 * at pace — invisible to all five, and able to fake a conversation or paste a
 * regular's line to defeat any further shape heuristic.
 *
 * The one thing a sender cannot forge is what OTHER people have independently
 * directed at them. So {@link computeTrusted} derives, per reader and rooted at
 * the reader, the authors the reader has earned reason to trust — reachable
 * through replies, quotes and mentions FROM the already-trusted — and:
 *
 * 6. **Untrusted drown** ({@link markUntrustedDrown}) — the keys the reader has
 *    no earned reason to trust who TOGETHER drown the channel (the cohort rule's
 *    share + pace + precedent, restated over the untrusted subset, minus its
 *    arrived-together gate). A clique vouching for itself builds no trust, so
 *    faking a conversation does not help; and a trusted author's rows are
 *    exempt from every rule at once, so pasting a regular's line folds only the
 *    spammer's copy. Earning one trusted reply, quote or mention clears a key.
 */

import type { OpenedChat } from "@/concord/lib/chat";
import { KIND_COMMENT, KIND_MESSAGE, KIND_POLL } from "@/concord/lib/kinds";

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
  /**
   * When each author was first heard IN THIS CHANNEL, from the store
   * (`queryChannelFirstSeen`) rather than from this batch.
   *
   * The batch is a rendering window, not the channel's life, and the cohort
   * rule's whole question — was this crowd already here — is unanswerable from
   * a window a flood has filled. Supplied values only ever move an author's
   * arrival EARLIER than the batch shows, or add authors the window pushed
   * out; an author the store hasn't got is still dated by the batch, so a
   * partial answer is safe.
   */
  firstSeen?: ReadonlyMap<string, number>;
  /**
   * Whether an author is community STAFF — the owner or a roster member holding
   * any staff permission (`STAFF_MASK`). Staff are never folded: authority to
   * moderate is the community's own strongest statement of trust, it outranks
   * anything this heuristic infers, and a muzzled moderator is worse than a
   * visible flood. They join the trusted set ({@link computeTrusted}) rather
   * than getting a check of their own, so the same immunity pass covers them.
   * Absent in bare lib folds (tests); the app path supplies it from the
   * control fold.
   */
  staff?: (author: string) => boolean;
  /**
   * A lower bound (ms) on when this room existed, used only by the drown rule as
   * an alternative source of precedent. The drown rule otherwise declines to
   * fire unless someone OUTSIDE the flood spoke before it ("a room of nothing
   * but strangers is a launch, not an invasion") — but that speaker signal is
   * empty in a TOTAL nuke, where every early speaker is itself a drowner. This
   * closes that hole: if the room existed before the wave by {@link
   * FLOOD_COHORT_PRECEDENT_MS}, it is an existing room being invaded, not a
   * launch, whatever the chat plane looks like.
   *
   * The app prefers an UNFORGEABLE source — the oldest control-plane rotation
   * time it holds (`HeldRoot.retiredAt`, a staff-only rekey publish time) — and
   * falls back to the earliest activity the store has observed in the channel
   * when no rotation time exists (the common case). That fallback is chat-plane
   * derived, so best-effort: a flood can only push it EARLIER (adding
   * precedent), and hiding it needs every `created_at` clamped into one
   * sub-{@link FLOOD_COHORT_PRECEDENT_MS} window, which collapses the very
   * timespan the pace gate reads. Absent in bare lib folds, in which case the
   * drown rule falls back to speaker-precedent alone.
   */
  establishedSinceMs?: number;
}

const URL_RUN = /https?:\/\/\S+/g;
const TRAILING_NONCE = /([>!])\s*[a-z0-9]{4,9}$/;
const DIGIT_TOKEN = /[\p{L}\p{N}]*\p{N}[\p{L}\p{N}]*/gu;
/** Three-plus of one letter: elongation (`nooo`), laughter (`kkkk`), mash (`ggggg`). */
const LETTER_RUN = /(\p{L})\1{2,}/gu;
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
    // A letter run is one keypress held down: `ggg` and `gggggg` are the same
    // message, and `noooo` is `no`. Two is a word (`gg`), three is a run.
    .replace(LETTER_RUN, "$1")
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

/**
 * Jaccard overlap of two token sets pre-interned to SORTED integer ids
 * ({@link internWords}). This is the fold's hot path on a rotating campaign
 * (tens of thousands of comparisons between 20-30-word templates), where a
 * `Set<string>` measure spent all its time hashing strings in `Set.has`; a
 * linear merge of two sorted `Int32Array`s is branch-predictable and
 * allocation-free.
 */
function similarityIds(a: Int32Array, b: Int32Array): number {
  let i = 0;
  let j = 0;
  let shared = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      shared++;
      i++;
      j++;
    } else if (a[i] < b[j]) {
      i++;
    } else {
      j++;
    }
  }
  return shared / (a.length + b.length - shared);
}

/**
 * Intern each eligible bucket's word set to a sorted `Int32Array` of ids for
 * {@link similarityIds}. Returned as a dense array indexed by bucket id (holes
 * for the ineligible), so the merge's hot comparison loop indexes rather than
 * hashes a Map key on every one of its tens of thousands of calls.
 */
function internWords(buckets: Bucket[], ids: Iterable<number>): (Int32Array | undefined)[] {
  const wordId = new Map<string, number>();
  const out: (Int32Array | undefined)[] = new Array(buckets.length);
  for (const i of ids) {
    const arr = new Int32Array(buckets[i].words.size);
    let k = 0;
    for (const w of buckets[i].words) {
      let id = wordId.get(w);
      if (id === undefined) wordId.set(w, (id = wordId.size));
      arr[k++] = id;
    }
    out[i] = arr.sort();
  }
  return out;
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

  const wordIds = internWords(buckets, eligible);
  const examine = (i: number, j: number) => {
    if (find(i) !== find(j) && similarityIds(wordIds[i]!, wordIds[j]!) >= FLOOD_SIMILARITY) {
      union(i, j);
    }
  };

  // Shared-word count per candidate bucket, in a reused typed array rather than
  // a fresh Map per bucket: this loop runs O(eligible × words × df) times on a
  // rotating campaign (thousands of near-unique templates over a small
  // vocabulary), where the Map's per-entry overhead dominated. `touched` lists
  // the ids to reset, so clearing stays O(touched).
  const count = new Int32Array(buckets.length);
  const touched: number[] = [];
  for (const i of eligible) {
    touched.length = 0;
    let maxShared = 0;
    for (const w of buckets[i].words) {
      const list = index.get(w);
      if (!list) continue;
      for (const j of list) {
        if (j >= i) continue; // each pair once
        if (count[j] === 0) touched.push(j);
        const c = ++count[j];
        if (c > maxShared) maxShared = c;
      }
    }
    // At most {@link CANDIDATE_CAP} candidates are compared. Below the cap the
    // order is irrelevant — union is commutative, so the connected components
    // are the same whichever order the edges are added — and the selection is
    // skipped entirely. Above it, the survivors are the ones sharing the most
    // words, chosen by a counting sort (O(touched), not an O(c·log c) comparison
    // sort per bucket): the cap then bites on candidates that were never going
    // to clear the threshold anyway. Both branches examine the same set.
    if (touched.length <= CANDIDATE_CAP) {
      for (const j of touched) examine(i, j);
    } else {
      const byCount: number[][] = [];
      for (const j of touched) (byCount[count[j]] ??= []).push(j);
      let examined = 0;
      for (let c = maxShared; c >= 1 && examined < CANDIDATE_CAP; c--) {
        const tier = byCount[c];
        if (!tier) continue;
        for (const j of tier) {
          examine(i, j);
          if (++examined >= CANDIDATE_CAP) break;
        }
      }
    }
    for (const j of touched) count[j] = 0;
  }
  return parent;
}

/** Per-message normalization, memoized on the row itself (folds re-run often). */
const normCache = new WeakMap<OpenedChat, { shape: string; words: string[]; gibberish: boolean }>();
function normalize(ev: OpenedChat): { shape: string; words: string[]; gibberish: boolean } {
  let n = normCache.get(ev);
  if (!n) {
    const shape = shapeKey(ev.content);
    normCache.set(ev, (n = { shape, words: normalizeTokens(shape), gibberish: isGibberish(shape) }));
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
  // The store knows the channel; the batch only knows the window. Merged
  // entries can only move an arrival earlier or add an author the window
  // pushed out — never date anyone later — so a partial map is safe.
  if (opts.firstSeen) {
    for (const [author, ms] of opts.firstSeen) {
      const seen = firstSeen.get(author);
      if (seen === undefined || ms < seen) firstSeen.set(author, ms);
    }
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
  // Trust is rooted at the reader and flows only through inbound attention, so
  // it is computed once and shared: the drown rule reads it to judge share by
  // stranger volume, and the immunity pass below reads it to protect the keys
  // the reader has vouched for from every rule at once.
  const trusted = computeTrusted(messages, opts.self, opts.staff);

  markArrivalBurst(messages, firstSeen, flagged, opts.self);
  markCohortFlood(messages, firstSeen, flagged, opts.self);
  markUntrustedDrown(messages, firstSeen, trusted, flagged, opts.self, opts.establishedSinceMs);
  markGibberish(messages, flagged, opts.self);
  sweepParticipants(messages, flagged, opts.self);

  // Earned-trust immunity, applied LAST so it overrides every rule. A key the
  // reader has replied to, quoted or mentioned (transitively) is never folded —
  // which is what defeats the copy-a-regular attack: pasting a trusted author's
  // sentence lands the copy in a content bucket, but only the SPAMMER's copy
  // folds, because the regular's own row is cleared here. `self` is in
  // `trusted`, so this also subsumes the per-rule self-exemption.
  if (trusted.size > 0) {
    for (const ev of messages) if (trusted.has(ev.author)) flagged.delete(ev.rumorId);
  }
  return flagged;
}

/** One batch's quarantine, keyed on the batch itself (see {@link quarantinedIn}). */
const quarantineCache = new WeakMap<
  readonly OpenedChat[],
  { self: string | undefined; staff: FloodOptions["staff"]; ids: Set<string> }
>();

/**
 * The flood quarantine for one channel's cached batch, memoized on the batch's
 * IDENTITY.
 *
 * The community-wide derived views (unread badges, mounted on the rail and the
 * page at once) re-derive on inputs that cannot change this answer — read
 * state, mute lists — and each mounted instance re-derives alone. But the
 * shared scan (`useCommunityRumors`) hands out one array per channel and
 * replaces it only when that channel actually ingested a rumor, so the array
 * IS the question's identity: the same batch folds the same way, whoever asks.
 * A read-state change is a cache hit; a delta scan recomputes exactly the
 * channels it replaced.
 *
 * Pure — no store read, so no `firstSeen`: this is the BADGE path, and it sees
 * only what the batch shows (the render path's store-backed map is
 * {@link FloodOptions.firstSeen}). The sort is here because `floodClusters`
 * expects ms order and the batch does not promise it.
 *
 * `staff` is threaded through for the same reason the render path carries it: a
 * moderator's messages must never fold a channel's badge either. It is part of
 * the cache key — a fold before the control roster resolved saw no staff and
 * must recompute once it does — and the caller passes a STABLE reference
 * (memoized on the roster) so a badge recompute is driven by real change, not a
 * fresh closure each render.
 *
 * The raw batch also carries SIDE-EVENTS — reactions, votes, deletes, edits —
 * which render no row and are dropped before judging. A reaction must not
 * date its author as present (reacting to your own spam is free warming, and
 * was used as exactly that) and must not count in a wave's share. The
 * timeline path gets the same behavior structurally: `foldTimeline` consumes
 * side-events into their targets before its fold runs.
 */
const SPEECH_KINDS: ReadonlySet<number> = new Set([KIND_MESSAGE, KIND_POLL, KIND_COMMENT]);

export function quarantinedIn(
  rumors: readonly OpenedChat[],
  self?: string,
  staff?: FloodOptions["staff"],
): Set<string> {
  const cached = quarantineCache.get(rumors);
  if (cached && cached.self === self && cached.staff === staff) return cached.ids;
  const ids = floodClusters(rumors.filter((r) => SPEECH_KINDS.has(r.kind)).sort((a, b) => a.ms - b.ms), {
    ...(self !== undefined ? { self } : {}),
    ...(staff !== undefined ? { staff } : {}),
  });
  quarantineCache.set(rumors, { self, staff, ids });
  return ids;
}

/** Keys arriving within this of the previous one chain into a single cohort. */
export const FLOOD_COHORT_WINDOW_MS = 600_000;
/**
 * Keys a wave needs before it folds on BREADTH alone, at any pace.
 *
 * A slow, broad cohort is a flood too — fifteen keys trickling through an hour
 * while nobody else speaks — so this path asks nothing about rate.
 */
export const FLOOD_COHORT_AUTHORS = 8;
/**
 * …or, for a wave running at {@link FLOOD_COHORT_RATE_PER_MIN}, this many.
 *
 * Breadth alone is far too slow to be the only trigger, and measuring it
 * against the live campaign is what showed why: its share was 1.00 and its
 * pace ~19 messages a minute from the very first message, but its keys were
 * introduced one every forty seconds, so an eight-key bar was not met until
 * eighty messages and four and a half minutes had gone by. The whole flood was
 * unmistakable within thirty seconds and the rule sat silent through it.
 *
 * Pace is what makes it adaptive. Three keys that arrived together, sustaining
 * ten messages a minute, drowning everyone else, in a channel that existed
 * before them — that is not a conversation, and waiting for the eighth key to
 * confirm it only costs the reader the five minutes it takes to arrive.
 */
export const FLOOD_COHORT_RATE_AUTHORS = 3;
/** The pace that lets {@link FLOOD_COHORT_RATE_AUTHORS} stand in for breadth. */
export const FLOOD_COHORT_RATE_PER_MIN = 10;
/** Messages one wave of a cohort must carry before it reads as a flood. */
export const FLOOD_COHORT_MESSAGES = 24;
/**
 * Messages a cohort member must itself have carried in the wave before its own
 * rows fold. The drowning is collective; the fold is individual.
 *
 * This is where the honest newcomer lives. Someone who follows an invite into a
 * channel that happens to be under attack arrives inside the cohort's window
 * and cannot be told apart from it by arrival alone — but they say one thing,
 * or two, and a key that said two things has not flooded anything. Without this
 * the rule folds exactly the person it most needs to keep, on their first
 * message, which is the worst row in the timeline to get wrong.
 *
 * It leaves a gap: a cohort where every key posts once or twice is not folded
 * here. That gap is {@link markArrivalBurst}'s shape and is deliberately its
 * job — many keys, one message apiece, gone again — and the division is what
 * lets each rule keep a bar the other would have to lower.
 */
export const FLOOD_COHORT_MIN_PER_AUTHOR = 3;
/**
 * Share of the channel a cohort's wave must occupy before it folds.
 *
 * THE discriminator between a flood and an influx, and the reason this rule can
 * be content-free. When an invite is posted somewhere busy the regulars are
 * still talking — the newcomers are a fraction of the room. When a sybil set
 * arrives the room is drowned: the live campaign this rule is measured against
 * ran 368 of the channel's 370 messages.
 */
export const FLOOD_COHORT_SHARE = 0.75;
/** Silence that ends a cohort's wave — the "until it stops" of the rule. */
export const FLOOD_COHORT_TAIL_MS = 3_600_000;
/**
 * How long before a cohort's arrival someone OUTSIDE it must have spoken — the
 * precedent that makes the cohort judgeable at all.
 *
 * The boundary {@link markArrivalBurst} guards with `lo === 0`, restated per
 * cohort: with no one here first, a crowd of first-time keys is a launch, not
 * an invasion, and the rule stays silent. It is a RELATIVE test against each
 * cohort on purpose. An earlier draft anchored it to the earliest message the
 * scan could see and exempted everyone near that "origin" as a founder — and
 * a flood hitting a channel that had been quiet for a day WAS the origin, so
 * its first ten minutes of keys inherited founder immunity and the fold sat
 * dead until enough history was scrolled in to push them out. Precedent has no
 * anchor to corrupt: the founder who said anything ten minutes before the
 * crowd arrived is precedent enough, at any window depth, live.
 */
export const FLOOD_COHORT_PRECEDENT_MS = 600_000;

/**
 * Rule 4: a crowd of keys that arrived together and then drowned the channel.
 *
 * The rule for a flood whose CONTENT is machine-generated per message. A
 * slot-filling grammar (`hey gang! my {relation} would not stop talking about
 * {topic}`) emits no two identical messages — the live campaign this is
 * measured against produced 370 distinct shapes from 370 messages, so every
 * bucket in this file was a singleton, no template ever repeated, and rules 1
 * and 2 could not fire at all. Improving the text costs the attacker one more
 * phrase list; there is no version of content matching that stays ahead of that
 * for long.
 *
 * So this rule reads none of it. It asks how much of the channel is coming from
 * keys that had not earned a place in it, which is a question the generator
 * cannot answer differently by writing better sentences. Evading it costs
 * either patience (warm the keys first — see the note on an adaptive attacker
 * below) or silence, and silence is the outcome we want.
 *
 * Three things keep it off an honest influx:
 *
 * - The cohort must be a CROWD ({@link FLOOD_COHORT_AUTHORS}) that arrived
 *   together, chained arrival-to-arrival so a conveyor that introduces a key
 *   every 40 seconds for half an hour is one cohort rather than thirty
 *   unremarkable singletons.
 * - Its wave must DROWN the channel ({@link FLOOD_COHORT_SHARE}) — the
 *   discriminator described there.
 * - Someone outside it must have spoken before it arrived
 *   ({@link FLOOD_COHORT_PRECEDENT_MS}), or this is a launch.
 *
 * Unlike {@link markArrivalBurst} this does NOT require a key's whole presence
 * to sit inside the arrival window. That test is satisfied exactly once per
 * key, which is what let the observed campaign through: its keys each talked
 * for five to seven minutes, so by the time they were flooding they were no
 * longer new. Cohort membership is fixed at ARRIVAL and the wave is bounded by
 * the cohort going quiet ({@link FLOOD_COHORT_TAIL_MS}) instead — so a key that
 * comes back tomorrow to say something ordinary is outside the wave and renders
 * normally. Nothing here brands a key permanently, and nothing here is a drop.
 */
function markCohortFlood(
  messages: readonly OpenedChat[],
  firstSeen: ReadonlyMap<string, number>,
  flagged: Set<string>,
  self: string | undefined,
): void {
  // Only authors with rows in THIS batch can join a cohort (an author the
  // store remembers but the window doesn't hold has nothing to fold), but
  // their arrival time is the merged map's — a regular caught inside a flood
  // window arrives at their real, old first-seen and chains into no cohort.
  const inBatch = new Set<string>();
  for (const ev of messages) inBatch.add(ev.author);
  const arrivals = [...firstSeen]
    .filter(([author]) => author !== self && inBatch.has(author))
    .sort((a, b) => a[1] - b[1]);
  // The lower of the two bars — whether a wave clears the breadth path or the
  // pace one is decided per wave, in markCohortWaves.
  if (arrivals.length < FLOOD_COHORT_RATE_AUTHORS) return;

  // Every arrival, batch-held or store-remembered: the precedent scan below
  // needs the authors the window pushed out, which is exactly the reading a
  // flood corrupts when precedent is judged from the batch alone.
  const allArrivals = [...firstSeen.values()].sort((a, b) => a - b);

  for (let start = 0; start < arrivals.length; ) {
    let end = start;
    while (
      end + 1 < arrivals.length &&
      arrivals[end + 1][1] - arrivals[end][1] <= FLOOD_COHORT_WINDOW_MS
    ) {
      end++;
    }
    if (end - start + 1 >= FLOOD_COHORT_RATE_AUTHORS) {
      const cohort = new Set(arrivals.slice(start, end + 1).map(([a]) => a));
      // Precedent: anyone at all — the reader included — arrived early enough
      // before this cohort to prove the channel existed without it.
      const bar = arrivals[start][1] - FLOOD_COHORT_PRECEDENT_MS;
      if (allArrivals[0] <= bar) {
        markCohortWaves(messages, cohort, flagged);
      }
    }
    start = end + 1;
  }
}

/** First index whose ms is >= `ms` (messages are ms-ascending). */
function lowerBound(messages: readonly OpenedChat[], ms: number): number {
  let lo = 0;
  let hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (messages[mid].ms < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Fold each of a cohort's waves that both carries enough messages and drowns
 * the channel while it runs. A wave ends where the cohort falls silent for
 * {@link FLOOD_COHORT_TAIL_MS}.
 */
function markCohortWaves(
  messages: readonly OpenedChat[],
  members: ReadonlySet<string>,
  flagged: Set<string>,
): void {
  const idx: number[] = [];
  for (let i = 0; i < messages.length; i++) if (members.has(messages[i].author)) idx.push(i);

  let waveStart = 0;
  for (let k = 1; k <= idx.length; k++) {
    const ends = k === idx.length || messages[idx[k]].ms - messages[idx[k - 1]].ms > FLOOD_COHORT_TAIL_MS;
    if (!ends) continue;
    const wave = idx.slice(waveStart, k);
    waveStart = k;
    if (wave.length < FLOOD_COHORT_MESSAGES) continue;

    // Everything the channel carried while the wave ran, the cohort included.
    const from = messages[wave[0]].ms;
    const to = messages[wave[wave.length - 1]].ms;
    const total = lowerBound(messages, to + 1) - lowerBound(messages, from);
    if (wave.length < total * FLOOD_COHORT_SHARE) continue;

    // The wave is the evidence; each key's own volume is what folds it.
    const carried = new Map<string, number>();
    for (const i of wave) carried.set(messages[i].author, (carried.get(messages[i].author) ?? 0) + 1);

    // Breadth OR pace (see FLOOD_COHORT_RATE_AUTHORS). A wave spanning no time
    // at all is every message sharing one timestamp — treated as infinitely
    // fast rather than dividing by zero, which is the right reading of it.
    const minutes = (to - from) / 60_000;
    const perMinute = minutes > 0 ? wave.length / minutes : Number.POSITIVE_INFINITY;
    const broad = carried.size >= FLOOD_COHORT_AUTHORS;
    const fast = carried.size >= FLOOD_COHORT_RATE_AUTHORS && perMinute >= FLOOD_COHORT_RATE_PER_MIN;
    if (!broad && !fast) continue;
    for (const i of wave) {
      if ((carried.get(messages[i].author) ?? 0) >= FLOOD_COHORT_MIN_PER_AUTHOR) {
        flagged.add(messages[i].rumorId);
      }
    }
  }
}

/**
 * Which authors this reader has EARNED reason to trust — computed locally, per
 * reader, from the batch. There are two kinds of root. The reading user is one
 * (nothing a stranger sends can fake being replied to by YOU). Community STAFF
 * are the other: the owner and permission-holders the community itself vouches
 * for, whose authority to moderate outranks anything this heuristic could
 * infer. Trust then flows outward from every root through inbound attention:
 * an edge `src → dst` when `src` replied to / quoted / mentioned `dst`. It is
 * the one signal a flood cannot manufacture, because it is not about what a key
 * did — volume, tenure, reacting to its own sybils are all free — but about
 * what an independently-trusted party chose to direct AT it.
 *
 * The graph is directed and rooted, so a spammer naming a regular (or the
 * reader) in a `p` tag makes an edge FROM the spammer, whose source is
 * untrusted, and grants nothing; the closure only ever widens through a party
 * already inside it.
 *
 * Staff differ from the reader in one deliberate way: they are seeded as
 * trusted (never folded) but are NOT propagation roots — their outbound
 * attention does not spread trust. The reader replying to someone is a clean
 * vouch, but a moderator's reply is not: moderating a flood MEANS replying to
 * it, quoting it to call it out, `p`-mentioning the spammer — so an outbound
 * staff edge would whitelist the flooder (and, transitively, every sybil it
 * had linked) the instant a mod pushed back. Immunity for a moderator's own
 * messages is the whole of the guarantee; vouching outward from it is the hole.
 * Only `self` spreads.
 *
 * Reactions would be an even stronger signal (the reader hearting a message),
 * but they are side-events consumed into tallies before the fold runs and are
 * not in `messages` — replies/quotes/mentions are what a speech row carries.
 *
 * With no `self` AND no staff (a bare lib fold) the set is empty: everyone is a
 * stranger, and the drown rule falls back to pace + share + precedent, which is
 * the intended trustless-room behavior.
 */
function computeTrusted(
  messages: readonly OpenedChat[],
  self: string | undefined,
  staff: ((author: string) => boolean) | undefined,
): Set<string> {
  const trusted = new Set<string>();
  const roots: string[] = [];
  if (self !== undefined) {
    trusted.add(self);
    roots.push(self); // the reader is the one root that spreads trust outward
  }
  // Staff are seeded as trusted regardless of `self`, so a moderator is immune
  // on the badge path too — but NOT as a root: a mod replying to a spammer to
  // moderate them must not whitelist the flood. Only authors present in the
  // batch need seeding (an absent one folds nothing), which also keeps the
  // predicate call count to the roster members actually speaking.
  if (staff) for (const ev of messages) if (staff(ev.author)) trusted.add(ev.author);
  // No root spreads (a badge-path/staff-only fold) ⇒ the seeds ARE the whole
  // set; skip building the attention graph.
  if (roots.length === 0) return trusted;

  // author → the pubkeys they directed attention at (reply/quote target's
  // author, or a `p`-mention). Rumor refs are resolved through the batch.
  const authorOf = new Map<string, string>();
  for (const ev of messages) authorOf.set(ev.rumorId, ev.author);
  const attends = new Map<string, Set<string>>();
  const addEdge = (src: string, dst: string) => {
    if (dst === src) return;
    let s = attends.get(src);
    if (!s) attends.set(src, (s = new Set()));
    s.add(dst);
  };
  for (const ev of messages) {
    for (const t of ev.tags) {
      if (t.length < 2 || !t[1]) continue;
      if (t[0] === "e" || t[0] === "E" || t[0] === "q") {
        const target = authorOf.get(t[1]);
        if (target) addEdge(ev.author, target);
      } else if (t[0] === "p" && /^[0-9a-f]{64}$/.test(t[1])) {
        addEdge(ev.author, t[1]);
      }
    }
  }

  // Reachability from every root over the attention edges.
  const queue = [...roots];
  while (queue.length) {
    const src = queue.pop()!;
    const outs = attends.get(src);
    if (!outs) continue;
    for (const dst of outs) if (!trusted.has(dst)) { trusted.add(dst); queue.push(dst); }
  }
  return trusted;
}

/**
 * Rule 6: the UNTRUSTED speakers who together drown the channel.
 *
 * The blind spot the shape rules share, and the arms race they lose: density
 * needs a repeated template (a per-message generator repeats none); echo,
 * arrival-burst and the cohort rule need a CROWD that ARRIVED together
 * (established keys don't); gibberish needs low-originality words (a fluent
 * pitch isn't). Two-or-three aged keys taking turns posting distinct, fluent
 * spam hit none of them — observed live as 3 keys at ~96% of the channel, and
 * the natural next move (fake a conversation between themselves, paste a
 * regular's line to drag them into a content bucket) defeats any rule that
 * reads the flood's SHAPE.
 *
 * So this rule reads none of the shape. It asks how much of the channel is
 * coming from keys the reader has earned no reason to trust ({@link
 * computeTrusted}), which is the one question better sentences and staged
 * chatter cannot answer differently. The flood's accomplices vouching for each
 * other builds no trust — the closure is rooted at the reader — so a clique
 * stays untrusted however much it interacts, and the copy-a-regular attack only
 * folds the spammer's own copy, because a trusted author's rows are exempt
 * (applied in {@link floodClusters}).
 *
 * The cohort rule's discriminators, restated over the untrusted subset, are
 * what keep this off an honest room:
 *
 * - **Drown.** The untrusted wave must be {@link FLOOD_COHORT_SHARE} of
 *   everything the channel carried while it ran. A real conversation with some
 *   spam in it keeps trusted voices talking, so the untrusted share stays low
 *   and nothing folds; only when strangers drown the room does it fire.
 * - **Pace.** Sustained at {@link FLOOD_COHORT_RATE_PER_MIN}, faster than
 *   people at keyboards hold across two dozen messages.
 * - **Precedent.** Someone OUTSIDE the wave spoke {@link
 *   FLOOD_COHORT_PRECEDENT_MS} before it, OR the room itself provably predates
 *   the wave by that margin ({@link FloodOptions.establishedSinceMs}) — else a
 *   room of nothing but strangers is a launch, not an invasion. The room-age
 *   source is what catches a TOTAL nuke, whose every early speaker is a drowner
 *   so the speaker source is empty (see that option for how the app sources it
 *   and the limits of the chat-plane fallback).
 *
 * A wave is bounded by the untrusted group's own silence
 * ({@link FLOOD_COHORT_TAIL_MS}); a key that returns tomorrow to say one
 * ordinary thing is outside it. Each key folds only once it has itself carried
 * {@link FLOOD_COHORT_MIN_PER_AUTHOR} of the wave, so a stranger who says two
 * things while a flood happens around them is left alone. Still a DISPLAY fold,
 * never a drop; one trusted reply, quote or mention clears a key that earned
 * it, on the next fold.
 */
function markUntrustedDrown(
  messages: readonly OpenedChat[],
  firstSeen: ReadonlyMap<string, number>,
  trusted: ReadonlySet<string>,
  flagged: Set<string>,
  self: string | undefined,
  establishedSinceMs: number | undefined,
): void {
  // The untrusted wave's messages, in ms order (already sorted in `messages`).
  const idx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const a = messages[i].author;
    if (a !== self && !trusted.has(a)) idx.push(i);
  }
  if (idx.length < FLOOD_COHORT_MESSAGES) return;

  let waveStart = 0;
  for (let k = 1; k <= idx.length; k++) {
    const ends = k === idx.length || messages[idx[k]].ms - messages[idx[k - 1]].ms > FLOOD_COHORT_TAIL_MS;
    if (!ends) continue;
    const wave = idx.slice(waveStart, k);
    waveStart = k;
    if (wave.length < FLOOD_COHORT_MESSAGES) continue;

    const from = messages[wave[0]].ms;
    const to = messages[wave[wave.length - 1]].ms;

    // Drown: the untrusted wave is most of what the channel carried while it
    // ran. If trusted voices are still getting a word in, this fails and the
    // room is judged a conversation, not a flood.
    const total = lowerBound(messages, to + 1) - lowerBound(messages, from);
    if (wave.length < total * FLOOD_COHORT_SHARE) continue;

    // Pace: sustained faster than a person plausibly holds. A wave spanning no
    // time at all is one timestamp's worth — treated as infinitely fast rather
    // than dividing by zero.
    const minutes = (to - from) / 60_000;
    const perMinute = minutes > 0 ? wave.length / minutes : Number.POSITIVE_INFINITY;
    if (perMinute < FLOOD_COHORT_RATE_PER_MIN) continue;

    // The GROUP is the keys actually carrying the wave — each past
    // {@link FLOOD_COHORT_MIN_PER_AUTHOR}. A stranger swept into the window who
    // said one or two things is neither folded nor counted as a drowner.
    const carried = new Map<string, number>();
    for (const i of wave) carried.set(messages[i].author, (carried.get(messages[i].author) ?? 0) + 1);
    const group = new Set<string>();
    for (const [a, n] of carried) if (n >= FLOOD_COHORT_MIN_PER_AUTHOR) group.add(a);
    if (group.size === 0) continue;

    // Precedent: proof the channel existed before this wave, so folding it is
    // catching an invasion rather than an honest launch. EITHER source suffices:
    //
    //  - A SPEAKER outside the drowning group was heard a clear margin before
    //    the wave. Read from `firstSeen` (the store's 7-day map, not this
    //    window), so the quiet before a flood is visible even when the flood has
    //    filled the render batch. Light and early speakers count; only the heavy
    //    hitters are excluded from being their own precedent, which is what lets
    //    a room of otherwise-untrusted regulars still supply it.
    //
    //  - The ROOM itself predates the wave (`establishedSinceMs`; see its doc
    //    for the source and its limits). This is the only precedent a TOTAL
    //    nuke leaves: when every early speaker is itself a drowner the speaker
    //    source is empty, and a channel that already had history drowned
    //    end-to-end would otherwise read as a launch and never fold.
    const cutoff = from - FLOOD_COHORT_PRECEDENT_MS;
    let othersEarliest = Number.POSITIVE_INFINITY;
    for (const [a, ms] of firstSeen) if (!group.has(a) && ms < othersEarliest) othersEarliest = ms;
    const hasPrecedent =
      othersEarliest <= cutoff || (establishedSinceMs !== undefined && establishedSinceMs <= cutoff);
    if (!hasPrecedent) continue;

    for (const i of wave) if (group.has(messages[i].author)) flagged.add(messages[i].rumorId);
  }
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

/** Distinct letters at or under which a message reads as low-originality. */
export const FLOOD_GIBBERISH_MAX_LETTERS = 2;
/**
 * Low-originality messages ONE key may post inside the window before the run
 * folds — the allowance ends on this one.
 *
 * Chosen against the honest twins rather than the attack: elongation, a laugh,
 * a `hmm`, a `gg` after a match are all low-originality and all fine in the
 * amounts a person actually produces. A dozen inside an hour from one key is a
 * habit the channel is being made to scroll past.
 */
export const FLOOD_GIBBERISH_MIN = 12;
/** Long, like the echo window: mash is a drizzle, not a burst. */
export const FLOOD_GIBBERISH_WINDOW_MS = 3_600_000;

/**
 * Does this shape draw on too few letters to be saying anything?
 *
 * Letter originality is the property keyboard mash cannot vary: a generator
 * can rephrase a pitch forever, but `g`, `ggg`, `aaa`, `nn` are low-diversity
 * by being what they are. One distinct letter is mash at any length. Two
 * distinct letters is mash from three letters up (`lol`, `haha`, `hmm`,
 * `kkkk`, `jajaja`) — but at exactly two letters it is the language itself
 * (`no`, `ok`, `gm`, `hi`, `ty`) and is never counted.
 */
export function isGibberish(shape: string): boolean {
  const letters = shape.match(/\p{L}/gu);
  if (!letters) return false;
  const distinct = new Set(letters).size;
  if (distinct > FLOOD_GIBBERISH_MAX_LETTERS) return false;
  return distinct === 1 || letters.length >= 3;
}

/**
 * Rule 5: one key spending its messages on noise rather than language.
 *
 * The lone-key wall the other four rules are structurally blind to: each
 * message its own singleton bucket (no density), one word (never
 * echo-eligible), one key (never a burst or a cohort). Two ways a message
 * reads as noise, and both spend the same allowance:
 *
 * - LETTERS ({@link isGibberish}): it draws on almost no alphabet — `g`,
 *   `ggg`, `aaa`, `nn`.
 * - VOCABULARY: it is a single word NO OTHER author in the batch uses —
 *   `fhuhacx`, `sfoe`, `chrl`. The adaptation that followed the letter rule
 *   was mash with more letters in it, and this is the property it cannot
 *   shed: a random string is foreign to the room by construction, while the
 *   room's real one-word messages (`ok`, `gm`, `lol`, `same`) are its SHARED
 *   vocabulary. Joining that vocabulary means repeating what the room says,
 *   which is the shape the density and echo rules already own. Judged only
 *   when the batch holds a second author at all — with no one else speaking,
 *   "words nobody shares" would describe every word.
 *
 * The policy is an allowance, and it is deliberate: a little low-originality
 * is a person being a person, and {@link FLOOD_GIBBERISH_MIN} of it inside
 * {@link FLOOD_GIBBERISH_WINDOW_MS} from one key is spamming, whatever the
 * intent behind it. That knowingly folds a heavy laugher — `kkkk`, `jajaja`,
 * `hhhh` are exactly low-originality — and, through {@link sweepParticipants},
 * the ordinary messages the wall interleaves. Accepted casualties: the fold is
 * one click to expand, and the row it collapses was a wall either way.
 *
 * Per key on purpose. Cross-key mash is the chorus (`gm`, `🎉`) this file has
 * repeatedly declined to fold, and the crowd-shaped rules already own the
 * crowd-shaped attacks.
 */
function markGibberish(
  messages: readonly OpenedChat[],
  flagged: Set<string>,
  self: string | undefined,
): void {
  // Each token's sole author, or null once a second author uses it. Built
  // over every row, the reader's included: their words are room vocabulary.
  const soleUser = new Map<string, string | null>();
  const authors = new Set<string>();
  for (const ev of messages) {
    authors.add(ev.author);
    for (const w of normalize(ev).words) {
      const cur = soleUser.get(w);
      if (cur === undefined) soleUser.set(w, ev.author);
      else if (cur !== null && cur !== ev.author) soleUser.set(w, null);
    }
  }
  const compareAuthors = authors.size >= 2;

  const byAuthor = new Map<string, number[]>();
  for (let i = 0; i < messages.length; i++) {
    const ev = messages[i];
    if (ev.author === self) continue;
    const n = normalize(ev);
    const foreign =
      compareAuthors && n.words.length === 1 && soleUser.get(n.words[0]) === ev.author;
    if (!n.gibberish && !foreign) continue;
    let list = byAuthor.get(ev.author);
    if (!list) byAuthor.set(ev.author, (list = []));
    list.push(i);
  }
  for (const idx of byAuthor.values()) {
    if (idx.length < FLOOD_GIBBERISH_MIN) continue;
    let lo = 0;
    let marked = 0;
    for (let hi = 0; hi < idx.length; hi++) {
      while (messages[idx[hi]].ms - messages[idx[lo]].ms > FLOOD_GIBBERISH_WINDOW_MS) lo++;
      if (hi - lo + 1 < FLOOD_GIBBERISH_MIN) continue;
      for (let i = Math.max(lo, marked); i <= hi; i++) flagged.add(messages[idx[i]].rumorId);
      marked = hi + 1;
    }
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
