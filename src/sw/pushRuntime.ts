/**
 * The Web Push service worker's runtime. `worker.ts` handles the worker's
 * events and `sw.ts` hands it these functions; the build bundles all three
 * into `/sw.js`. For the inlined push event (`inline_event`, see
 * `pushSubscriptions.ts`) it:
 *   - OPENS it via the app's own `openDmWrap`/`openWrap`, so the worker can't
 *     apply laxer anti-spoof/seal/NIP-40 rules than the page;
 *   - STORES it in ArmadaDB (IndexedDB) via `writeDm17Rumors`/`writeRumors`;
 *   - PRESENTS it with names/images read from that same database.
 * Every step is best-effort; failure falls back to the gateway's static wake-up.
 */

import { getConversationKey, decrypt as nip44Decrypt } from "nostr-tools/nip44";
import { verifyEvent } from "nostr-tools/pure";
import { hexToBytes } from "@noble/hashes/utils.js";

import { checkChannelBinding, FUTURE_HOLD_MS, openWrap } from "@/concord/lib/stream";
import { KIND_MESSAGE, KIND_REACTION, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import { decryptImageBytes } from "@/concord/lib/image";
import { writeRumors } from "@/concord/lib/rumorStore";
import { hasEveryoneMention } from "@/concord/lib/everyoneMention";
import { presetIndexedDBArmadaDB } from "@/lib/db/armadaDB";
import { APP_BLOSSOM_SERVERS } from "@/lib/blossom";
import { appEventStore } from "@/lib/db/mainEventStore";
import { getDisplayName } from "@/lib/getDisplayName";
import { mediaPolicyFromConfig, mediaSrc, type MediaPolicy } from "@/lib/mediaPolicy";
import { writeDm17Rumors } from "@/lib/nip17/dm17Store";
import { KIND_DM_CHAT, KIND_DM_FILE, openDmWrap } from "@/lib/nip17/protocol";
import { dmConvKey } from "@/lib/nip17/conversation";
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
import type { PushScope } from "@/lib/pushSubscriptions";
import type { SwConcordStream, SwPushConfig } from "@/lib/swPushConfig";

// The worker shares the page's store; fix the adapter before anything reads.
presetIndexedDBArmadaDB();

/**
 * What the worker knows about one push. A legacy gateway echoed `scope` and
 * `relays` back from the registration; a `napp.push.payload` carries only the
 * event and where it came from, so `scope` is derived ({@link pushScope}).
 */
export interface PushData {
  scope?: PushScope;
  relays?: unknown;
  url?: string;
  event?: NostrEvent;
  [key: string]: unknown;
}

/**
 * What the worker needs to show one notification. `line` is separate because
 * accumulating lines needs `registration.getNotifications` (worker-side).
 */
export interface PreparedPush {
  /**
   * Show NOTHING (vs undefined = "use your fallback", which is visible). Only
   * the decrypted rumor reveals own-device sends or others' reactions, so
   * silence must be requestable.
   */
  drop?: true;
  /** Collapse tag — one entry per conversation. */
  tag: string;
  /** Exact active-room key shared with the foreground page, when resolvable. */
  roomKey?: string;
  /** Opened rumor/event id shared with the foreground page for acknowledgement. */
  eventId?: string;
  /** Deep link for `notificationclick`. */
  url: string;
  title: string;
  /** This message's line, to append to the room's recent ones. */
  line: string;
  icon: string;
  badge: string;
  /** The message's own `created_at`, in ms. */
  timestamp: number;
  /** Unknown sender under the `off` policy: as quiet as possible, never silent (iOS revokes those). */
  quiet?: boolean;
  /** Whether earlier room lines may show; content-blind request pings must not accumulate. */
  accumulate: boolean;
}

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
 * Open an inlined NIP-17 wrap, or null (can't open, malformed, expired). Uses
 * `openDmWrap` so seal, anti-spoof, id-hash and expiry checks are identical to
 * the app's. Own-sent copies are handled by `prepareDm`.
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

/**
 * Open an inlined Concord chat wrap via the stream keyed by `wrap.pubkey` (no
 * trial decryption). Channel/epoch bindings are checked against the opening
 * stream to stop cross-channel splices. The seal MUST be encrypted (CORD-02 §5).
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
    checkChannelBinding(ev, stream.channelId, epoch);
    if (ev.kind !== KIND_MESSAGE && ev.kind !== KIND_REACTION) return undefined;
    return { opened: { ...ev, channelIdHex: stream.channelId, epoch }, stream };
  } catch {
    // not ours, spliced, or malformed
    return undefined;
  }
}

/** The one value of `name`, or undefined when absent or repeated (CORD-01). */
function uniqueTag(tags: string[][], name: string): string | undefined {
  const found = tags.filter((t) => t[0] === name);
  return found.length === 1 ? found[0][1] : undefined;
}

/** The viewer's media policy from the sealed config (older configs get the default). */
function policyOf(cfg: SwPushConfig | null): MediaPolicy {
  return mediaPolicyFromConfig(cfg?.mediaPolicy);
}

/**
 * Sender name and avatar from the local kind-0 only, the avatar routed per
 * media policy (the OS fetches notification icons from this device).
 */
async function profileFor(pubkey: string, policy: MediaPolicy): Promise<{ name: string; avatar?: string }> {
  try {
    const store = await appEventStore();
    const [ev] = await store.query([{ kinds: [0], authors: [pubkey], limit: 1 }]);
    if (ev) {
      const metadata = JSON.parse(ev.content) as NostrMetadata;
      const name = getDisplayName(metadata, pubkey);
      const picture = typeof metadata.picture === "string" && /^https:\/\//.test(metadata.picture)
        ? metadata.picture
        : undefined;
      const avatar = mediaSrc(picture, policy);
      return { name, avatar };
    }
  } catch {
    // store unreadable
  }
  return { name: "Anonymous" };
}

/** Resolve the names a message's NIP-27 mentions refer to, locally. */
async function mentionNamesFor(content: string, policy: MediaPolicy): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const keys = mentionPubkeys(content);
  if (keys.length === 0) return names;
  await Promise.all(keys.map(async (pk) => {
    const { name } = await profileFor(pk, policy);
    if (name !== "Anonymous") names.set(pk, name);
  }));
  return names;
}

/**
 * A community icon as a `data:` URL (workers lack `URL.createObjectURL`).
 * Usually served from the `concord-images` cache; oversized icons are skipped.
 */
async function imageDataUrl(pointer: ImagePointer, policy: MediaPolicy): Promise<string | undefined> {
  try {
    const { bytes, mime } = await decryptImageBytes(pointer, undefined, APP_BLOSSOM_SERVERS, policy);
    if (bytes.byteLength > 512 * 1024) return undefined;
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return `data:${mime};base64,${btoa(binary)}`;
  } catch {
    return undefined;
  }
}

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
function requestPing(
  quiet: boolean,
  eventId?: string,
  roomKey?: string,
): PreparedPush {
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
    eventId,
    roomKey,
  };
}

/** Compose a prepared notification from an opened message. */
async function present(
  msg: Omit<NotificationMessage, "authorName" | "authorAvatar" | "mentionNames">,
  author: string,
  room: { title?: string; image?: string },
  route: { tag: string; url: string; timestamp: number; roomKey?: string; eventId?: string },
  policy: MediaPolicy,
): Promise<PreparedPush> {
  const [{ name, avatar }, mentionNames] = await Promise.all([
    profileFor(author, policy),
    mentionNamesFor(msg.content, policy),
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
    roomKey: route.roomKey,
    eventId: route.eventId,
  };
}

/** NIP-29 kinds the group subscriptions watch (`buildPushSubscriptions`). */
const GROUP_KINDS = new Set([9, 1111, 7]);

/**
 * Which plane an event belongs to, from the event alone.
 *
 * A `napp.push.payload` says nothing about which subscription matched: both
 * transports send the event and the relay it came from, and nostr-push2 merges
 * every subscription into one list. The event is enough. A kind-1059 is a
 * Concord wrap when its author is one of our stream addresses — routing is by
 * `pubkey` there, as in {@link openConcord} — and a NIP-17 wrap when it is
 * addressed to us; an `h`-tagged group kind is NIP-29. Undefined for anything
 * this install cannot place, which then gets the generic fallback.
 */
export function pushScope(event: NostrEvent, cfg: SwPushConfig | null): PushScope | undefined {
  const addressedToSelf = Boolean(cfg?.self)
    && event.tags.some(([name, value]) => name === "p" && value === cfg?.self);
  if (event.kind === 1059) {
    if (cfg?.concord?.some((stream) => stream.pk === event.pubkey)) return "c2";
    return addressedToSelf ? "dm" : undefined;
  }
  if (event.kind === 4) return "dm";
  if (GROUP_KINDS.has(event.kind) && uniqueTag(event.tags, "h") !== undefined) {
    return addressedToSelf ? "group-mention" : "group";
  }
  return undefined;
}

/**
 * Open the inlined event, store it, and return what to show (undefined = static
 * fallback). Storing comes FIRST: the message must survive even if presentation fails.
 */
export async function preparePush(
  data: PushData,
  cfg: SwPushConfig | null,
): Promise<PreparedPush | undefined> {
  const wrapOrEvent = data.event;
  if (!wrapOrEvent || typeof wrapOrEvent !== "object") return undefined;

  // Tenna delivers what its relays sent without checking it, and a fetched
  // event is only as good as the relay that answered. A forged event is not a
  // message; say nothing about it.
  if (!verifyEvent(wrapOrEvent)) return DROP;

  const relays = Array.isArray(data.relays) ? (data.relays as string[]) : [];
  const scope = data.scope ?? pushScope(wrapOrEvent, cfg);

  // Fail closed only for the non-authoritative plane; `undefined` = ready (older configs).
  if (scope === "dm") {
    if (cfg?.dmReady === false) return DROP;
    return prepareDm(wrapOrEvent, cfg);
  }
  if (scope === "c2") {
    if (cfg?.concordReady === false) return DROP;
    return prepareConcord(wrapOrEvent, cfg);
  }
  if (scope === "group" || scope === "group-mention") {
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

  // Persist first (including own sent copies from other devices).
  await writeDm17Rumors(cfg.self, [opened]).catch(() => undefined);

  const conversation = dmConvKey(opened.peers);
  const roomKey = `dm:${conversation}`;

  if (opened.author === cfg.self) return DROP;

  // Like the DM list: any muted participant hides the conversation, even under `full`.
  if (opened.peers.some((peer) => cfg.mutedPeers?.includes(peer))) return DROP;

  // Per-conversation levels are device policy (the gateway can't see the
  // conversation); both `all` and `mentions` admit DMs.
  const dmLevel = cfg.dmLevels?.[conversation];
  if (dmLevel === "nothing" || (!dmLevel && cfg.directMessages === false)) return DROP;

  // Non-message rumors still need something shown on iOS: the request ping.
  if (opened.kind !== KIND_DM_CHAT && opened.kind !== KIND_DM_FILE) {
    return requestPing(true, opened.rumorId, roomKey);
  }

  const known = cfg.knownConversations?.includes(conversation)
    || opened.peers.every((peer) => cfg.knownPeers.includes(peer));
  if (!known && cfg.policy !== "full") {
    // A stranger controls text, name and avatar: gate all three.
    return requestPing(cfg.policy === "off", opened.rumorId, roomKey);
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
      tag: `dm-${conversation}`,
      roomKey,
      eventId: opened.rumorId,
      url: `/dm/${conversation}`,
      timestamp: opened.createdAt * 1000,
    },
    policyOf(cfg),
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

  // Store it regardless: the timeline has no other copy.
  await writeRumors(stream.communityId, [opened]).catch(() => undefined);

  // Future-dated messages are held by the timeline (FUTURE_HOLD_MS); don't announce yet.
  if (opened.ms > Date.now() + FUTURE_HOLD_MS) return DROP;

  // Own message from another device (only the decrypted author reveals it).
  if (cfg?.self && opened.author === cfg.self) return DROP;

  // Muted (level `nothing`): stored, never announced — silences a lingering gateway sub.
  if (stream.muted) return DROP;

  // Banned (CORD-04): stored, never announced.
  if (stream.banned?.includes(opened.author)) return DROP;

  const mention = Boolean(cfg?.self) && (
    opened.tags.some(([n, v]) => n === "p" && v === cfg?.self)
    || (
      stream.mentionEveryoneAuthors?.includes(opened.author)
      && hasEveryoneMention(opened.content)
    )
  );
  const reaction = opened.kind === KIND_REACTION;
  // Reactions only notify when pointing at YOUR message (`p` on the encrypted rumor).
  if (reaction && !mention) return DROP;

  // Mentions-only can only be enforced here, after decryption.
  if (stream.mentionOnly && !mention) return DROP;

  const policy = policyOf(cfg);
  const room = await concordRoomIdentity(stream.communityId, stream.channelId);
  const image = room.iconPointer ? await imageDataUrl(room.iconPointer, policy) : undefined;

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
      roomKey: `c2:${stream.channelId}`,
      eventId: opened.rumorId,
      // Link to the reacted-to message.
      url: `${base}/m/${encodeURIComponent(uniqueTag(opened.tags, "e") ?? opened.rumorId)}`,
      timestamp: opened.createdAt * 1000,
    },
    policy,
  );
}

/**
 * A NIP-29 group message (plaintext). NOT stored: legacy multi-relay
 * registrations lack exact room identity for a tenant write, and plaintext is
 * refetched on open.
 */
async function prepareGroup(
  ev: NostrEvent,
  relays: string[],
  cfg: SwPushConfig | null,
): Promise<PreparedPush | undefined> {
  const groupId = uniqueTag(ev.tags, "h");
  if (!groupId || typeof ev.content !== "string") return undefined;
  if (cfg?.self && ev.pubkey === cfg.self) return DROP; // our own, from another device

  // Name the room only if exactly ONE relay tenant knows this group id.
  const identities = await Promise.all(
    relays.map(async (relay) => ({ relay, room: await nip29RoomIdentity(relay, groupId) })),
  );
  const named = identities.filter((i) => i.room.title);
  const exact = identities.length === 1 ? identities[0] : undefined;
  const only = exact ?? (named.length === 1 ? named[0] : undefined);

  const mention = Boolean(cfg?.self) && ev.tags.some(([n, v]) => n === "p" && v === cfg?.self);
  const policy = policyOf(cfg);
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
    // A kind-39000 `picture` is operator-controlled: policed like an avatar.
    { title: only?.room.title, image: mediaSrc(only?.room.iconUrl, policy) },
    {
      tag: `h:${groupId}`,
      // Unresolved unless exactly one tenant identifies the group.
      roomKey: only ? `h:${only.relay}|${groupId}` : undefined,
      eventId: ev.id,
      url: only ? groupUrl(only.relay, groupId, ev.id) : (relays[0] ? groupUrl(relays[0], groupId, ev.id) : "/"),
      timestamp: ev.created_at * 1000,
    },
    policy,
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
