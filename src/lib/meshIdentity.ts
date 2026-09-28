/**
 * Display identity for Bluetooth-mesh peers (not Nostr identities), derived from
 * the peer id: `anon<4hex>` nickname, bitchat-compatible color, and a `#abcd`
 * suffix to disambiguate. Kept separate from the Nostr identity path.
 */

/** Self color, matching bitchat's reserved orange for "me". */
export const MESH_SELF_COLOR = "#ff9500";

/** `anon` + first 4 hex chars of the id; stable because the id derives from the persistent Noise key. */
export function meshAnonName(peerID: string): string {
  return `anon${peerID.slice(0, 4).toLowerCase()}`;
}

/** Last 4 hex chars of the id, shown after the name to distinguish same-named peers. */
export function meshSuffix(peerID: string): string {
  return peerID.slice(-4).toLowerCase();
}

/** djb2 as unsigned 64-bit; BigInt so wraparound (and colors) match bitchat's Kotlin/iOS exactly. */
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
 * Deterministic color, ported from bitchat `colorForPeerSeed` (seed `noise:<id>`).
 * Orange is nudged away (reserved for self). Dark-theme variant.
 */
export function meshColor(peerID: string): string {
  const hash = djb2(`noise:${peerID.toLowerCase()}`);
  let hue = Number(hash % 360n) / 360;
  const orange = 30 / 360;
  if (Math.abs(hue - orange) < 0.05) hue = (hue + 0.12) % 1.0;
  return hsvToHex(hue * 360, 0.5, 0.85);
}

export interface MeshIdentity {
  name: string;
  color: string;
  suffix: string;
}

/** Resolve display identity; falls back to `anon<4hex>` without a usable nickname. */
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

/** `@<name>#<suffix>` — bitchat's plain-text convention, pinned to a device by the suffix. */
export function meshMentionToken(identity: MeshIdentity): string {
  return `@${identity.name}#${identity.suffix}`;
}

/** Matches `@name#abcd` mentions. Global: callers reset `lastIndex`. */
export const MESH_MENTION_REGEX = /@([\p{L}\p{N}_.-]+)#([0-9a-f]{4})/giu;

/** Whether `content` mentions us, matched by our unique suffix. False without our peer id. */
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
