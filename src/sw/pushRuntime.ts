/**
 * The Web Push service worker's runtime — everything a push needs beyond the
 * worker APIs themselves.
 *
 * `public/sw.js` is a hand-written CLASSIC service worker (no bundler, no
 * `import`) on purpose — see its header. This module is bundled to a standalone
 * IIFE it loads with `importScripts`, so the worker stays a plain file the
 * build-stamp plugin can rewrite while the logic lives under `src/` as ordinary
 * source that tsc + eslint + vitest cover. Same arrangement as
 * `electron/db.cjs`, and for the same reason.
 *
 * It started as NIP-17 unwrapping alone (`dmCrypto.ts`) because a classic
 * worker can't do NIP-44 — secp256k1 ECDH isn't in WebCrypto. It now does the
 * whole job, because the push payload carries the event itself
 * (`inline_event`, see `pushSubscriptions.ts`) and everything worth doing with
 * an event needs code the worker can't otherwise reach:
 *
 *   - OPEN it. NIP-17 gift wraps and Concord stream wraps, through the SAME
 *     functions the app uses (`openDmWrap`, `openWrap`), so the worker cannot
 *     end up applying a laxer rule than the page — the anti-spoof check, the
 *     seal-form check, the NIP-40 expiry refusal at all three levels.
 *   - STORE it. ArmadaDB is IndexedDB on the web and a worker can open it, so a
 *     message that arrives while no tab exists is written to the tenant the app
 *     reads it from and is simply THERE on open. This is what the Android
 *     background service does with the shared SQLite file; the web now does it
 *     one layer down, through the same rule-bearing writers
 *     (`writeDm17Rumors`, `writeRumors`).
 *   - PRESENT it. The room's title and image and the sender's name and avatar
 *     come out of that same database, for any author — not from a snapshot the
 *     page had to seal ahead of time and re-seal when a profile landed late.
 *
 * Everything here is best-effort and non-fatal. Any step that fails returns
 * null and the worker falls back to the static wake-up the gateway sent, which
 * is why a build without this bundle, a login whose key it doesn't hold, and a
 * message too big to inline all degrade to the same safe place.
 *
 * NAMES: the emitted file is still `sw-crypto.js` and the global is still
 * `ArmadaDmCrypto`. Those are the strings an ALREADY-INSTALLED worker asks for,
 * and a worker updates only on the next navigation — renaming them would break
 * DM push for one revalidation cycle on every existing install, to no benefit.
 * Same reasoning as the `c2:`/`concord2-*` on-disk identifiers; don't "finish"
 * the rename.
 */

import { getConversationKey, decrypt as nip44Decrypt } from "nostr-tools/nip44";
import { hexToBytes } from "@noble/hashes/utils.js";

import { checkChannelBinding, openWrap } from "@/concord/lib/stream";
import { KIND_MESSAGE, KIND_REACTION, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import { decryptImageBytes } from "@/concord/lib/image";
import { writeRumors } from "@/concord/lib/rumorStore";
import { presetIndexedDBArmadaDB } from "@/lib/db/armadaDB";
import { appEventStore } from "@/lib/db/mainEventStore";
import { getDisplayName } from "@/lib/getDisplayName";
import { writeDm17Rumors } from "@/lib/nip17/dm17Store";
import { KIND_DM_CHAT, KIND_DM_FILE, openDmWrap } from "@/lib/nip17/protocol";
import {
  attributedLine,
  firstImetaMime,
  isThreadReply,
  mentionPubkeys,
  NOTIFICATION_BADGE_ICON,
  NOTIFICATION_FALLBACK_ICON,
  presentNotification,
  type NotificationMessage,
} from "@/lib/notificationPreview";
import { concordRoomIdentity, nip29RoomIdentity } from "@/lib/notificationRoom";
import { openSealedConfig } from "@/lib/swSecretVault";

import type { OpenedChat } from "@/concord/lib/chat";
import type { ImagePointer } from "@/concord/lib/types";
import type { NostrEvent, NostrMetadata } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { SwConcordStream, SwPushConfig } from "@/lib/swPushConfig";

// The worker shares the page's store; fix the adapter before anything reads.
presetIndexedDBArmadaDB();

/** The routing hints the gateway echoes back in `data` (see pushSubscriptions). */
interface PushData {
  scope?: string;
  relays?: unknown;
  url?: string;
  event?: NostrEvent;
  [key: string]: unknown;
}

/**
 * What the worker needs to show one notification, once the event is open.
 *
 * `line` is handed back separately from `title`/`icon` because accumulating a
 * room's recent lines needs `registration.getNotifications`, a worker API this
 * bundle has no business reaching for.
 */
export interface PreparedPush {
  /**
   * Show NOTHING for this push, and mean it — as distinct from returning
   * undefined, which means "I couldn't decide, use your fallback".
   *
   * The difference matters because the fallback is a visible notification. A
   * message the user sent from another device, or a reaction to somebody
   * else's message, would otherwise announce itself as "New message in a
   * community": the worker can only tell either from the DECRYPTED rumor, so
   * by the time it knows, silence has to be something it can ask for.
   *
   * The worker still spends its Apple keep-alive here, exactly as it does for
   * any other suppressed push.
   */
  drop?: true;
  /** Collapse tag — one entry per conversation. */
  tag: string;
  /** Deep link for `notificationclick`. */
  url: string;
  title: string;
  /** This message's line, to append to the room's recent ones. */
  line: string;
  icon: string;
  badge: string;
  /** The message's own `created_at`, in ms. */
  timestamp: number;
  /**
   * Show this as quietly as the platform allows: an unknown sender under the
   * `off` request policy. Never truly silent — iOS revokes a subscription that
   * displays nothing.
   */
  quiet?: boolean;
  /** Whether the room's earlier lines may be shown beside this one. A
   *  content-blind request ping must not accumulate. */
  accumulate: boolean;
}

// ── DM ───────────────────────────────────────────────────────────────────────

/** A raw-key NIP-44 signer, so the worker can drive the app's own `openDmWrap`. */
function rawSigner(skHex: string) {
  const sk = hexToBytes(skHex);
  return {
    nip44: {
      encrypt: () => Promise.reject(new Error("the push worker never encrypts")),
      decrypt: (pubkey: string, ciphertext: string) =>
        Promise.resolve(nip44Decrypt(ciphertext, getConversationKey(sk, pubkey))),
    },
  };
}

/**
 * Open an inlined NIP-17 gift wrap, or null for anything this key can't open,
 * that's malformed, that has already expired (NIP-40), or that is the user's own
 * sent copy.
 *
 * Delegates to `openDmWrap` rather than reimplementing the envelope: that is
 * where the kind-13 seal check, the NIP-59 anti-spoof (`rumor.pubkey ===
 * seal.pubkey`), the id-is-its-own-hash check and the three-level expiry
 * refusal live, and a notification path that checked fewer of them would be a
 * second, laxer reader of the same bytes.
 *
 * Whether the sender turns out to be the user themselves is NOT decided here —
 * that is a presentation policy, and `prepareDm` needs to tell it apart from a
 * wrap that simply wouldn't open.
 */
export async function openDm(
  wrap: NostrEvent,
  skHex: string,
  self: string,
): Promise<Awaited<ReturnType<typeof openDmWrap>>> {
  try {
    return await openDmWrap(wrap, rawSigner(skHex), self);
  } catch {
    return undefined;
  }
}

// ── Concord ──────────────────────────────────────────────────────────────────

/**
 * Open an inlined Concord chat wrap with the stream key that claims it, or null.
 *
 * Routing is by `wrap.pubkey` — the stream address is the wrap's author, in the
 * clear — so this is one map lookup and one decrypt, never trial decryption.
 * `openWrap` verifies the seal's signature and the author binding; the channel
 * and epoch bindings are checked here against the stream that actually opened
 * it, which is what stops a keyholder splicing a rumor from one channel into
 * another.
 *
 * The seal MUST be encrypted (CORD-02 §5), matching `chat.ts`'s rule and NOT
 * the Android service's laxer one: a plaintext seal would make the message a
 * standalone signed artifact any relay could display.
 */
export function openConcord(
  wrap: NostrEvent,
  streams: SwConcordStream[],
): { opened: OpenedChat; stream: SwConcordStream } | undefined {
  const stream = streams.find((s) => s.pk === wrap.pubkey);
  if (!stream) return undefined;
  try {
    const ev = openWrap(wrap as NostrRumor, {
      pk: stream.pk,
      convKey: hexToBytes(stream.convKey),
    });
    if (ev.sealKind !== KIND_SEAL_ENCRYPTED) return undefined;
    const epoch = BigInt(stream.epoch);
    // Throws on a splice — the app's own check, not a second spelling of it.
    checkChannelBinding(ev, stream.channelId, epoch);
    if (ev.kind !== KIND_MESSAGE && ev.kind !== KIND_REACTION) return undefined;
    return { opened: { ...ev, channelIdHex: stream.channelId, epoch }, stream };
  } catch {
    // Not ours, spliced, or malformed — silent.
    return undefined;
  }
}

/** The one value of `name`, or undefined when absent or repeated (CORD-01). */
function uniqueTag(tags: string[][], name: string): string | undefined {
  const found = tags.filter((t) => t[0] === name);
  return found.length === 1 ? found[0][1] : undefined;
}

// ── Local lookups ────────────────────────────────────────────────────────────

/** A sender's display name and avatar from the local kind-0, never the network. */
async function profileFor(pubkey: string): Promise<{ name: string; avatar?: string }> {
  try {
    const store = await appEventStore();
    const [ev] = await store.query([{ kinds: [0], authors: [pubkey], limit: 1 }]);
    if (ev) {
      const metadata = JSON.parse(ev.content) as NostrMetadata;
      const name = getDisplayName(metadata, pubkey);
      const avatar = typeof metadata.picture === "string" && /^https:\/\//.test(metadata.picture)
        ? metadata.picture
        : undefined;
      // A profile with no name reads "Anonymous", which is a fact this worker
      // established by looking — unlike the old sealed snapshot, where a
      // missing entry only ever meant the page hadn't sealed one yet.
      return { name, avatar };
    }
  } catch {
    // Store unreadable — fall through.
  }
  return { name: "Anonymous" };
}

/** Resolve the names a message's NIP-27 mentions refer to, locally. */
async function mentionNamesFor(content: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const keys = mentionPubkeys(content);
  if (keys.length === 0) return names;
  await Promise.all(keys.map(async (pk) => {
    const { name } = await profileFor(pk);
    if (name !== "Anonymous") names.set(pk, name);
  }));
  return names;
}

/**
 * A community icon as a `data:` URL.
 *
 * `URL.createObjectURL` is Window-only, so a worker cannot hand
 * `showNotification` a blob. Inlining the bytes is the one route left — and it
 * costs nothing on the common path, because `decryptImageBytes` answers from
 * the content-addressed `concord-images` cache the app already filled.
 * Oversized icons are skipped rather than embedded: a multi-megabyte string in
 * a push handler is not worth an avatar.
 */
async function imageDataUrl(pointer: ImagePointer): Promise<string | undefined> {
  try {
    const { bytes, mime } = await decryptImageBytes(pointer);
    if (bytes.byteLength > 512 * 1024) return undefined;
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return `data:${mime};base64,${btoa(binary)}`;
  } catch {
    return undefined;
  }
}

// ── Preparation ──────────────────────────────────────────────────────────────

/** Deep link to a message in a NIP-29 group (mirrors `routes.ts`). */
function groupUrl(relayUrl: string, groupId: string, eventId: string): string {
  const param = encodeURIComponent(
    relayUrl.replace(/^wss?:\/\//i, (m) => (m.toLowerCase() === "ws://" ? "ws:" : "")),
  );
  return `/s/${param}/${encodeURIComponent(groupId)}/m/${encodeURIComponent(eventId)}`;
}

/** Show nothing at all for this push (see {@link PreparedPush.drop}). */
const DROP: PreparedPush = {
  drop: true,
  tag: "",
  url: "/",
  title: "",
  line: "",
  icon: NOTIFICATION_FALLBACK_ICON,
  badge: NOTIFICATION_BADGE_ICON,
  timestamp: 0,
  accumulate: false,
};

/** The content-blind ping for an unknown sender: nothing they control. */
function requestPing(quiet: boolean): PreparedPush {
  return {
    tag: "armada-dm-requests",
    url: "/dm",
    title: "Message requests",
    line: quiet ? "You have new message requests" : "You have a new message request",
    icon: NOTIFICATION_FALLBACK_ICON,
    badge: NOTIFICATION_BADGE_ICON,
    timestamp: Date.now(),
    quiet,
    accumulate: false,
  };
}

/** Compose a prepared notification from an opened message. */
async function present(
  msg: Omit<NotificationMessage, "authorName" | "authorAvatar" | "mentionNames">,
  author: string,
  room: { title?: string; image?: string },
  route: { tag: string; url: string; timestamp: number },
): Promise<PreparedPush> {
  const [{ name, avatar }, mentionNames] = await Promise.all([
    profileFor(author),
    mentionNamesFor(msg.content),
  ]);
  const full: NotificationMessage = {
    ...msg,
    authorName: name,
    authorAvatar: avatar,
    roomTitle: room.title,
    roomImage: room.image,
    mentionNames,
  };
  const presented = presentNotification(full);
  return {
    tag: route.tag,
    url: route.url,
    title: presented.title,
    line: attributedLine(full),
    icon: presented.icon,
    badge: presented.badge,
    timestamp: route.timestamp,
    accumulate: true,
  };
}

/**
 * Open the event the gateway inlined, store it, and return what to show — or
 * undefined to fall back to the static wake-up.
 *
 * Storing happens BEFORE presenting, and deliberately: the notification is a
 * side effect of a message arriving, and the message arriving is the part that
 * has to survive. A store that failed still shows the notification; a
 * presentation that failed has still persisted the message.
 */
export async function preparePush(
  data: PushData,
  cfg: SwPushConfig | null,
): Promise<PreparedPush | undefined> {
  const wrapOrEvent = data.event;
  if (!wrapOrEvent || typeof wrapOrEvent !== "object") return undefined;

  const relays = Array.isArray(data.relays) ? (data.relays as string[]) : [];

  if (data.scope === "dm") return prepareDm(wrapOrEvent, cfg);
  if (data.scope === "c2") return prepareConcord(wrapOrEvent, cfg);
  if (data.scope === "group" || data.scope === "group-mention") {
    return prepareGroup(wrapOrEvent, relays, cfg);
  }
  return undefined;
}

async function prepareDm(
  wrap: NostrEvent,
  cfg: SwPushConfig | null,
): Promise<PreparedPush | undefined> {
  if (!cfg?.sk) return undefined; // non-nsec login → the worker can't decrypt
  const opened = await openDm(wrap, cfg.sk, cfg.self);
  if (!opened) return undefined;

  // Persist first: a DM exists nowhere else once it is read off the relay.
  // This includes the user's own sent copy, which is how the other device's
  // half of a conversation reaches this one at all.
  await writeDm17Rumors(cfg.self, [opened]).catch(() => undefined);

  // Our own sent copy is addressed to us too, and is not news.
  if (opened.author === cfg.self) return DROP;

  // Reactions/deletes/timer changes aren't messages, but the push must still
  // show something on iOS — the content-blind request ping.
  if (opened.kind !== KIND_DM_CHAT && opened.kind !== KIND_DM_FILE) return requestPing(true);

  const known = cfg.knownPeers.includes(opened.author);
  if (!known && cfg.policy !== "full") {
    // A stranger picks the text, the name and the avatar alike — gate all three
    // BEFORE any of it reaches the screen.
    return requestPing(cfg.policy === "off");
  }

  return present(
    {
      plane: "dm",
      kind: opened.kind,
      content: opened.content,
      imetaMime: firstImetaMime(opened.tags),
      threadReply: isThreadReply(opened.kind, opened.tags),
    },
    opened.author,
    {},
    {
      tag: `dm-${opened.author}`,
      url: `/dm/${opened.author}`,
      timestamp: opened.createdAt * 1000,
    },
  );
}

async function prepareConcord(
  wrap: NostrEvent,
  cfg: SwPushConfig | null,
): Promise<PreparedPush | undefined> {
  const streams = cfg?.concord;
  if (!streams || streams.length === 0) return undefined;
  const result = openConcord(wrap, streams);
  if (!result) return undefined;
  const { opened, stream } = result;

  // Store it either way: a message we won't announce is still a message, and
  // the timeline it belongs to has no other copy.
  await writeRumors(stream.communityId, [opened]).catch(() => undefined);

  // Our own message, sent from another device. The local send marks its own
  // event id, but nothing marks one made elsewhere — only the decrypted author
  // tells us, and that is here.
  if (cfg?.self && opened.author === cfg.self) return DROP;

  // A banned member (CORD-04): stored above like every other message, folded
  // off the timeline on read, and — here — never announced. The author is on
  // the encrypted rumor, so this is the first place it can be checked.
  if (stream.banned?.includes(opened.author)) return DROP;

  const mention = Boolean(cfg?.self)
    && opened.tags.some(([n, v]) => n === "p" && v === cfg?.self);
  const reaction = opened.kind === KIND_REACTION;
  // A reaction notifies only when it points at one of YOUR messages; the `p`
  // tag is on the encrypted rumor, so this is the first place it can be read.
  if (reaction && !mention) return DROP;

  const room = await concordRoomIdentity(stream.communityId, stream.channelId);
  const image = room.iconPointer ? await imageDataUrl(room.iconPointer) : undefined;

  const base = `/c/${stream.communityId}/${stream.channelId}`;
  return present(
    {
      plane: "c2",
      kind: opened.kind,
      content: opened.content,
      mention,
      reaction,
      imetaMime: firstImetaMime(opened.tags),
      threadReply: isThreadReply(opened.kind, opened.tags),
    },
    opened.author,
    { title: room.title, image },
    {
      tag: `c2:${stream.channelId}`,
      // A reaction points at the message it reacted to — the thing the reader
      // is being told about, and the only one of the two the timeline can show.
      url: `${base}/m/${uniqueTag(opened.tags, "e") ?? opened.rumorId}`,
      timestamp: opened.createdAt * 1000,
    },
  );
}

/**
 * A NIP-29 group message, which arrives in the clear.
 *
 * Deliberately NOT stored. A NIP-29 group id names nothing without its relay
 * (`relayScope.ts`), and the push payload carries no source-relay attribution —
 * only the subscription's whole relay list — so filing it would mean guessing a
 * tenant. Nothing is lost by declining: the message is plaintext on a relay the
 * app re-reads on open, which is exactly the case the "NO RELAY, NO STORE" rule
 * says is refetchable.
 */
async function prepareGroup(
  ev: NostrEvent,
  relays: string[],
  cfg: SwPushConfig | null,
): Promise<PreparedPush | undefined> {
  const groupId = uniqueTag(ev.tags, "h");
  if (!groupId || typeof ev.content !== "string") return undefined;
  if (cfg?.self && ev.pubkey === cfg.self) return DROP; // our own, from another device

  // Ask each candidate relay's tenant for the group's metadata and accept a
  // name only if exactly ONE of them knows this group — with several relays
  // configured, a hit on two would be two different groups that merely share an
  // id, and naming the notification after either is a coin toss.
  const identities = await Promise.all(
    relays.map(async (relay) => ({ relay, room: await nip29RoomIdentity(relay, groupId) })),
  );
  const named = identities.filter((i) => i.room.title);
  const only = named.length === 1 ? named[0] : undefined;

  const mention = Boolean(cfg?.self) && ev.tags.some(([n, v]) => n === "p" && v === cfg?.self);
  return present(
    {
      plane: "nip29",
      kind: ev.kind,
      content: ev.content,
      mention,
      imetaMime: firstImetaMime(ev.tags),
      threadReply: isThreadReply(ev.kind, ev.tags),
    },
    ev.pubkey,
    { title: only?.room.title, image: only?.room.iconUrl },
    {
      tag: `h:${groupId}`,
      url: only ? groupUrl(only.relay, groupId, ev.id) : (relays[0] ? groupUrl(relays[0], groupId, ev.id) : "/"),
      timestamp: ev.created_at * 1000,
    },
  );
}

/** Open the sealed config, or null when it can't be opened. */
export async function openConfig(sealed: Uint8Array | undefined): Promise<SwPushConfig | null> {
  if (!sealed) return null;
  try {
    return (await openSealedConfig(sealed)) as SwPushConfig | null;
  } catch {
    return null;
  }
}

// Expose to the classic service worker (which loads this bundle via
// importScripts and can't consume ES exports). Assigned as a top-level side
// effect so rollup keeps it in the IIFE build even though nothing imports it
// there; the named exports above are what vitest drives.
(
  globalThis as unknown as { ArmadaDmCrypto?: Record<string, unknown> }
).ArmadaDmCrypto = {
  preparePush,
  openDm,
  openConcord,
  // The config is AES-GCM sealed at rest under a non-extractable key
  // (swSecretVault); the worker reads the bytes out of Cache Storage and opens
  // them here, then hands the result to `preparePush`.
  openConfig,
};
