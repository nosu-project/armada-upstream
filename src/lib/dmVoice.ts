/**
 * DM voice rooms.
 *
 * Unlike group voice (keyed on a NIP-29 group id), a 1:1 DM has no server-side
 * group object and each peer identifies the conversation by the *other*
 * person's pubkey. To give both peers a single shared LiveKit room name, we
 * derive a deterministic id from the two pubkeys: sort them ascending and join
 * as `dm:<lower>:<higher>`. Both sides compute the same string independently.
 *
 * The relay's `/.well-known/nip29/livekit-dm/<roomId>` endpoint validates this
 * format and authorizes a caller iff their pubkey is one of the two encoded.
 */

const DM_ROOM_PREFIX = "dm:";

/** Whether a string is a 64-char lowercase hex pubkey. */
function isHex64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/**
 * Derive the canonical shared DM voice room id for the two participants.
 * Returns undefined if either pubkey is malformed or they're identical.
 */
export function deriveDmRoomId(selfPubkey: string, peerPubkey: string): string | undefined {
  const a = selfPubkey.toLowerCase();
  const b = peerPubkey.toLowerCase();
  if (!isHex64(a) || !isHex64(b) || a === b) return undefined;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `${DM_ROOM_PREFIX}${lo}:${hi}`;
}

/** Whether a room id is a DM voice room (vs. a NIP-29 group id). */
export function isDmRoomId(roomId: string): boolean {
  return roomId.startsWith(DM_ROOM_PREFIX);
}

/**
 * The two participant pubkeys encoded in a DM room id, or undefined if it isn't
 * a well-formed DM room id.
 */
export function dmRoomParticipants(roomId: string): [string, string] | undefined {
  if (!isDmRoomId(roomId)) return undefined;
  const parts = roomId.slice(DM_ROOM_PREFIX.length).split(":");
  if (parts.length !== 2) return undefined;
  const [a, b] = parts;
  if (!isHex64(a) || !isHex64(b) || a >= b) return undefined;
  return [a, b];
}

/** The peer's pubkey within a DM room, from the current user's perspective. */
export function dmRoomPeer(roomId: string, selfPubkey: string): string | undefined {
  const pair = dmRoomParticipants(roomId);
  if (!pair) return undefined;
  const self = selfPubkey.toLowerCase();
  if (pair[0] === self) return pair[1];
  if (pair[1] === self) return pair[0];
  return undefined;
}
