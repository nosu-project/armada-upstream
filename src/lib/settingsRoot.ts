/**
 * The NIP-78 settings root: the ONE kind-30078 event the user's own key signs
 * for Armada's private state (`d = ${APP_ID}`, nothing else in the tags). Its
 * plaintext holds the secret every other settings document's key and `d` are
 * derived from (`settingsKeys.ts`); see `docs/settings-documents.md`.
 *
 * Fingerprint resistance: every edition has the same tags and the same
 * plaintext length, so the ciphertext length never says which version wrote it
 * or what else it carries. A field added later takes its bytes from `pad`.
 */

import { APP_ID } from "@/lib/platform";

import type { NostrRumor } from "@/lib/nostrRumor";

/** Exact UTF-8 length of every root plaintext. Never change: it is the disguise. */
export const ROOT_PLAINTEXT_BYTES = 512;

export const SETTINGS_ROOT_KIND = 30078;

const HEX_64 = /^[0-9a-f]{64}$/;
const ENCODER = new TextEncoder();

/** The root's `d` tag; a fork with its own APP_ID gets its own root. */
export function settingsRootDTag(): string {
  return APP_ID;
}

export interface SettingsRootPayload {
  v: 1;
  /** 32-byte secret, lowercase hex. */
  root: string;
  /** Fields a newer build added; carried through a rewrite untouched. */
  [extra: string]: unknown;
}

/** Serialize to exactly {@link ROOT_PLAINTEXT_BYTES}, or throw if it cannot fit. */
export function encodeSettingsRoot(payload: SettingsRootPayload): string {
  if (!HEX_64.test(payload.root)) throw new Error("Invalid settings root secret");
  const { pad: _pad, ...rest } = payload;
  const bare = JSON.stringify({ ...rest, v: 1, root: payload.root, pad: "" });
  const room = ROOT_PLAINTEXT_BYTES - ENCODER.encode(bare).byteLength;
  if (room < 0) throw new Error("Settings root payload exceeds its fixed size");
  const out = JSON.stringify({ ...rest, v: 1, root: payload.root, pad: " ".repeat(room) });
  // Spaces are one byte and need no escaping, so this holds by construction.
  if (ENCODER.encode(out).byteLength !== ROOT_PLAINTEXT_BYTES) {
    throw new Error("Settings root payload length mismatch");
  }
  return out;
}

/** Parse a decrypted root plaintext; null for anything that is not a v1 root. */
export function decodeSettingsRoot(plaintext: string): SettingsRootPayload | null {
  try {
    const value: unknown = JSON.parse(plaintext);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const payload = value as Record<string, unknown>;
    if (payload.v !== 1 || typeof payload.root !== "string" || !HEX_64.test(payload.root)) return null;
    const { pad: _pad, ...rest } = payload;
    return rest as SettingsRootPayload;
  } catch {
    return null;
  }
}

/** Exactly the tags a root carries. No `client`, `title` or `published_at`: they would vary. */
export function settingsRootTags(): string[][] {
  return [["d", settingsRootDTag()]];
}

/** Whether `event` is a root event authored by `pubkey`. */
export function isSettingsRootEvent(event: NostrRumor, pubkey: string): boolean {
  return event.kind === SETTINGS_ROOT_KIND
    && event.pubkey === pubkey
    && event.tags.some(([name, value]) => name === "d" && value === settingsRootDTag());
}

/** NIP-01 addressable ordering: newer, then the lower id. */
export function newestSettingsRoot<T extends NostrRumor>(events: readonly T[], pubkey: string): T | undefined {
  let best: T | undefined;
  for (const event of events) {
    if (!isSettingsRootEvent(event, pubkey)) continue;
    if (
      !best
      || event.created_at > best.created_at
      || (event.created_at === best.created_at && event.id < best.id)
    ) best = event;
  }
  return best;
}
