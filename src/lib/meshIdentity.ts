/**
 * Display identity for Bluetooth-mesh peers.
 *
 * Mesh peers are NOT Nostr identities, so they can't go through the kind-0
 * author/profile resolution the rest of the app uses. Instead we derive a
 * stable, human-friendly identity purely from the mesh peer id:
 *
 *   - a default "anon<4hex>" nickname (incognito), stable per device because the
 *     peer id is derived from the device's persistent Noise key fingerprint;
 *   - a deterministic color (djb2 → HSV), ported from bitchat so Armada and
 *     bitchat assign the SAME color to the same peer;
 *   - a short "#abcd" suffix so two peers who pick the same nickname (or both
 *     run incognito) stay visually distinct and individually @-referenceable.
 *
 * Keeping this self-contained means none of it leaks into the Nostr identity
 * path (`useAuthor`/`useScopedIdentity`): the mesh UI passes the resolved
 * identity into the shared message row as an explicit override.
 */

/** Self color, matching bitchat's reserved orange for "me". */
export const MESH_SELF_COLOR = "#ff9500";

/**
 * The incognito nickname for a peer id: `anon` + the first 4 hex chars of the
 * id (lowercased). Stable across sessions because the peer id is derived from
 * the device's persistent Noise key fingerprint.
 */
export function meshAnonName(peerID: string): string {
  return `anon${peerID.slice(0, 4).toLowerCase()}`;
}

/**
 * A short disambiguating suffix (`abcd`) for a peer id — the last 4 hex chars,
 * lowercased. Rendered muted after the name (e.g. "Alice #3f9a") so identically
 * named peers stay distinct and individually referenceable.
 */
export function meshSuffix(peerID: string): string {
  return peerID.slice(-4).toLowerCase();
}

/**
 * djb2 hash of a UTF-8 string as an unsigned 64-bit value. BigInt is used so
 * the 2^64 wraparound matches the Kotlin/iOS bitchat implementation exactly
 * (and therefore yields the same colors).
 */
function djb2(seed: string): bigint {
  let hash = 5381n;
  const mask = (1n << 64n) - 1n;
  for (const byte of new TextEncoder().encode(seed)) {
    hash = (((hash << 5n) + hash) + BigInt(byte)) & mask; // hash * 33 + byte
  }
  return hash;
}

/** Convert HSV (h in degrees, s/v in 0..1) to a `#rrggbb` hex string. */
function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  const to255 = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, "0");
  return `#${to255(r)}${to255(g)}${to255(b)}`;
}

/**
 * A deterministic display color for a mesh peer, ported from bitchat
 * (`colorForPeerSeed`). The peer id is seeded as `noise:<id>` so it matches
 * bitchat's mesh-peer seeding. Orange (~30°) is nudged away because it's
 * reserved for "me". The app is dark-themed, so the dark variant is used.
 */
export function meshColor(peerID: string): string {
  const hash = djb2(`noise:${peerID.toLowerCase()}`);
  let hue = Number(hash % 360n) / 360;
  const orange = 30 / 360;
  if (Math.abs(hue - orange) < 0.05) hue = (hue + 0.12) % 1.0;
  // Dark-theme saturation/value from bitchat (the app is dark by default).
  return hsvToHex(hue * 360, 0.5, 0.85);
}

/** A mesh peer's resolved display identity (name + color + disambiguator). */
export interface MeshIdentity {
  /** The name to show (announced nickname, or the anon fallback). */
  name: string;
  /** Deterministic color derived from the peer id. */
  color: string;
  /** Short `#abcd` disambiguating suffix (peer-id tail). */
  suffix: string;
}

/**
 * Resolve a peer's display identity from its id and announced nickname. When a
 * peer announces no usable nickname (or announced its own anon name), the
 * stable `anon<4hex>` fallback is used. `isSelf` swaps in the reserved self
 * color.
 */
export function meshIdentity(
  peerID: string,
  nickname: string | undefined,
  isSelf = false,
): MeshIdentity {
  const trimmed = nickname?.trim();
  const name = trimmed && trimmed.length > 0 ? trimmed : meshAnonName(peerID);
  return {
    name,
    color: isSelf ? MESH_SELF_COLOR : meshColor(peerID),
    suffix: meshSuffix(peerID),
  };
}

/**
 * The `@`-mention token for a peer: `@<name>#<suffix>` (e.g. `@anon3f9a#6f70`).
 * Matches bitchat's `nick#abcd` disambiguation convention and is plain text, so
 * it survives the BLE wire and reads sensibly on bitchat clients too. The
 * suffix pins the mention to a specific device even when two peers share a name.
 */
export function meshMentionToken(identity: MeshIdentity): string {
  return `@${identity.name}#${identity.suffix}`;
}

/**
 * Matches a mesh mention token in message text: `@name#abcd`. The name allows
 * letters, digits, underscore, hyphen and dot (covers `anon3f9a`, `armada-…`,
 * and NIP-05-ish names); the suffix is exactly 4 hex chars. Global + unicode so
 * the renderer can walk every mention. `g` state is reset by the caller.
 */
export const MESH_MENTION_REGEX = /@([\p{L}\p{N}_.-]+)#([0-9a-f]{4})/giu;

/**
 * Whether a message body mentions the local user, by matching any
 * `@name#suffix` token against our own suffix (the peer-id tail is unique per
 * device, so the suffix alone is a reliable self-check). Returns false when we
 * don't yet know our own peer id.
 */
export function meshMentionsMe(content: string, myPeerID: string | null): boolean {
  if (!myPeerID) return false;
  const mySuffix = meshSuffix(myPeerID);
  const re = new RegExp(MESH_MENTION_REGEX.source, "giu");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[2].toLowerCase() === mySuffix) return true;
  }
  return false;
}
