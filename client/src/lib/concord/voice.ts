/**
 * Concord voice — the client side of the "blind broker" voice design.
 *
 * Concord communities have no host, so there is no roster a LiveKit token
 * broker could check. Instead authority is **key possession**: anyone holding a
 * channel's key can derive a per-(channel, epoch) signing key (`voiceSigner`)
 * whose x-only pubkey IS the LiveKit room name. To join voice the client
 * self-signs a short grant with that key; a community-agnostic broker mints a
 * LiveKit JWT after verifying only that the grant was signed by the key whose
 * pubkey equals the room name. The broker never learns the community, the
 * membership, or who is in the room.
 *
 * Media is end-to-end encrypted under `voiceE2EEKey` (fed to LiveKit's
 * ExternalE2EEKeyProvider), so the SFU forwards ciphertext it cannot decode.
 *
 * Everything is keyed by the channel epoch, so a rekeyed-out member can no
 * longer derive the signer (can't get a token) or the media key (can't decode).
 */

import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";

import { voiceE2EEKey, voiceSigner } from "@/lib/concord/derive";
import {
  buildInnerEvent,
  openMessageMulti,
  sealWithSignedInner,
  type OpenedMessage,
} from "@/lib/concord/envelope";
import { KIND_COMMUNITY_PRESENCE } from "@/lib/concord/kinds";
import type { Channel } from "@/lib/concord/types";

/** NIP-98 HTTP Auth event kind, reused as the grant carrier. */
const KIND_HTTP_AUTH = 27235;

/** Cap on a community's voice-server (blind broker) set. */
export const MAX_VOICE_SERVERS = 3;

/**
 * The LiveKit room name for a channel at its current epoch: the lowercase-hex
 * x-only pubkey of the per-(channel, epoch) voice signer. Using the signer
 * pubkey as the room name makes the broker's binding automatic — "room name ==
 * grant signer" needs no separate lookup.
 */
export function voiceRoomName(channel: Channel): string {
  const sk = voiceSigner(channel.key, channel.id, channel.epoch);
  // getPublicKey returns the 32-byte x-only key as hex.
  return getPublicKey(sk);
}

/** The E2EE media key every member feeds to LiveKit's key provider. */
export function voiceMediaKey(channel: Channel): Uint8Array {
  return voiceE2EEKey(channel.key, channel.id, channel.epoch);
}

/**
 * Build the broker token endpoint URL for a room on a given voice server.
 * `voiceServer` is an https origin (the broker derives its HTTP origin like the
 * relay does). The room name is hex (64 chars), so it is path-safe as-is.
 */
export function voiceTokenUrl(voiceServer: string, roomName: string): string {
  const base = voiceServer.replace(/\/+$/, "");
  return `${base}/.well-known/concord/voice/${roomName}`;
}

/** The capability-probe URL for a voice server (broker answers 204). */
export function voiceCapabilityUrl(voiceServer: string): string {
  return `${voiceServer.replace(/\/+$/, "")}/.well-known/concord/voice`;
}

/**
 * Self-sign the grant the broker verifies: a kind-27235 event signed by the
 * channel's voice signer key (so `event.pubkey === roomName`), with the
 * endpoint `u` tag, the GET method, and a `room` tag echoing the room name.
 * Anyone holding the channel key can produce this; nobody else can.
 */
export function signVoiceGrant(channel: Channel, voiceServer: string): { grant: NostrEvent; roomName: string } {
  const sk = voiceSigner(channel.key, channel.id, channel.epoch);
  const roomName = getPublicKey(sk);
  const url = voiceTokenUrl(voiceServer, roomName);
  const grant = finalizeEvent(
    {
      kind: KIND_HTTP_AUTH,
      content: "",
      tags: [
        ["u", url],
        ["method", "GET"],
        ["room", roomName],
      ],
      created_at: Math.floor(Date.now() / 1000),
    },
    sk,
  );
  return { grant, roomName };
}

interface VoiceTokenResponse {
  /** LiveKit access JWT. */
  token: string;
  /** LiveKit server websocket URL. */
  url: string;
}

/**
 * Fetch a LiveKit JWT for a Concord channel's voice room from a blind broker.
 * The broker authorizes by verifying the self-signed grant — it learns only an
 * opaque room id (the signer pubkey) and that someone who can derive its key
 * wants in. `identityPubkey` is the user's real pubkey, sent only for display
 * (the broker does not and cannot gate on it).
 */
export async function fetchVoiceToken(
  channel: Channel,
  voiceServer: string,
  identityPubkey: string,
): Promise<VoiceTokenResponse> {
  const { grant, roomName } = signVoiceGrant(channel, voiceServer);
  const url = voiceTokenUrl(voiceServer, roomName);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Concord ${btoa(JSON.stringify(grant))}`,
      "X-Concord-Identity": identityPubkey,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Concord voice token request failed: HTTP ${res.status}`);
  }
  const data: Record<string, string> = await res.json();
  const token = data.token ?? data.participant_token;
  const serverUrl = data.url ?? data.server_url;
  if (!token || !serverUrl) {
    throw new Error("Concord voice token response missing token or url");
  }
  return { token, url: serverUrl };
}

/** Extract the leading 64-char hex pubkey from a LiveKit participant identity. */
export function pubkeyFromVoiceIdentity(identity: string): string {
  const m = identity.match(/^[0-9a-f]{64}/);
  return m ? m[0] : identity;
}

/** Dedupe (order-preserving) + cap a voice-server set. */
export function capVoiceServers(servers: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of servers) {
    if (out.length >= MAX_VOICE_SERVERS) break;
    const v = s.trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

// ── Voice presence (sealed kind-3306, channel-pseudonym addressed) ──────────
//
// Presence rides Concord's own append plane, NOT the relay's NIP-29 kind-39004
// webhook path — so the broker/relay stays blind to who is in voice. A member
// in a call publishes a sealed kind-3306 marked `voice` + `status` + the broker
// it joined through, refreshed on a heartbeat; on leave it publishes `left`.
// Readers decrypt under the channel key (only members can), prove authorship via
// the inner signature, and treat presence older than the stale window as gone.
//
// The broker on each presence is the RENDEZVOUS HINT: a late joiner joins
// whatever broker the people already in voice are on, so members on different
// armada hosts converge on one room without any community-level config. The
// community carries zero voice infrastructure state — the broker is purely a
// client choice plus this live hint.

/** How often a member in voice republishes its presence heartbeat (ms). */
export const VOICE_PRESENCE_HEARTBEAT_MS = 20_000;

/**
 * How long a presence announcement stays "live" without a refresh (ms). Must
 * comfortably exceed the heartbeat so a single dropped publish doesn't blink a
 * present member out. ~2.5 heartbeats.
 */
export const VOICE_PRESENCE_STALE_MS = 50_000;

const TAG_PRESENCE_SCOPE = "voice";
const TAG_PRESENCE_STATUS = "status";
const TAG_PRESENCE_BROKER = "broker";

/** A live voice participant: who, and which broker (rendezvous hint) they're on. */
export interface VoicePresenceEntry {
  pubkey: string;
  /** The broker origin this participant joined through (the rendezvous hint), if announced. */
  broker?: string;
}

/**
 * Seal a voice-presence announcement (kind 3306) for a channel. The inner event
 * is signed by the author's real key (authorship proof) and tagged `voice` +
 * `status=joined|left` (+ the broker on a join); sealed under the channel key +
 * addressed by the channel pseudonym, exactly like a chat message.
 */
export function sealVoicePresence(
  channel: Channel,
  signedInner: NostrEvent,
): NostrEvent {
  return sealWithSignedInner(signedInner, channel.key, channel.id, channel.epoch);
}

/**
 * Build the unsigned inner kind-3306 voice-presence event (caller signs it).
 * On a `joined`, `broker` records which voice server this member is on so others
 * converge there.
 */
export function buildVoicePresenceInner(channel: Channel, status: "joined" | "left", broker?: string) {
  const inner = buildInnerEvent({
    channelId: channel.id,
    epoch: channel.epoch,
    kind: KIND_COMMUNITY_PRESENCE,
    content: "",
    ms: Date.now(),
  });
  const tags = [...inner.tags, [TAG_PRESENCE_SCOPE, "1"], [TAG_PRESENCE_STATUS, status]];
  if (status === "joined" && broker) tags.push([TAG_PRESENCE_BROKER, broker.replace(/\/+$/, "")]);
  return { ...inner, tags };
}

/** Whether an opened message is a voice-presence announcement. */
function isVoicePresence(msg: OpenedMessage): boolean {
  return msg.kind === KIND_COMMUNITY_PRESENCE && msg.tags.some((t) => t[0] === TAG_PRESENCE_SCOPE);
}

/** The presence status carried by a voice-presence message. */
function presenceStatus(msg: OpenedMessage): "joined" | "left" {
  const v = msg.tags.find((t) => t[0] === TAG_PRESENCE_STATUS)?.[1];
  return v === "left" ? "left" : "joined";
}

/** The broker origin a presence message announces, if any. */
function presenceBroker(msg: OpenedMessage): string | undefined {
  const v = msg.tags.find((t) => t[0] === TAG_PRESENCE_BROKER)?.[1];
  return v ? v.replace(/\/+$/, "") : undefined;
}

/**
 * Fold a batch of opened messages into the live voice participants. Per author,
 * the latest (by ms) voice-presence message wins; a `joined` that isn't stale
 * counts as present (carrying its broker hint), a `left` or a stale `joined`
 * does not. `now` is epoch-ms (injectable for tests).
 */
export function foldVoicePresence(messages: OpenedMessage[], now: number): VoicePresenceEntry[] {
  // author → latest voice-presence message
  const latest = new Map<string, OpenedMessage>();
  for (const msg of messages) {
    if (!isVoicePresence(msg)) continue;
    const prev = latest.get(msg.author);
    if (!prev || msg.ms > prev.ms) latest.set(msg.author, msg);
  }
  const present: VoicePresenceEntry[] = [];
  for (const [author, msg] of latest) {
    if (presenceStatus(msg) !== "joined") continue;
    if (now - msg.ms > VOICE_PRESENCE_STALE_MS) continue;
    present.push({ pubkey: author, broker: presenceBroker(msg) });
  }
  return present;
}

/**
 * The rendezvous broker for a channel given its live presence: the broker the
 * people already in voice are on. When multiple brokers are present (a cold-start
 * race or netsplit), pick deterministically — the lexicographically smallest
 * origin — so every client converges on the same one. Returns undefined if no
 * one is in voice (the caller then uses its own client-preferred server).
 */
export function rendezvousBroker(present: VoicePresenceEntry[]): string | undefined {
  const brokers = present.map((p) => p.broker).filter((b): b is string => Boolean(b));
  if (brokers.length === 0) return undefined;
  return brokers.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0];
}

/** Re-export read helpers so the presence hook imports only from this module. */
export { openMessageMulti };

