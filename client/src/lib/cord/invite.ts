/**
 * CORD public (link) invites — CORD-05.
 *
 * Same architecture as v1: the URL fragment carries a 32-byte fetch-token that
 * derives a decrypt key, an addressable locator, and a signer; the bundle
 * waits passively on relays. Everything derives under the CORD label family
 * (`concord/invite-*`), so a CORD link can never collide with (or be confused
 * for) a v1 bundle — a v3 fragment's token simply addresses a different
 * coordinate. Re-posting under the coordinate refreshes the link (fresh keys
 * behind the same URL after a Refounding); the token-signed tombstone retires
 * it for good.
 *
 * The bundle event stays kind 30078 (an addressable event, the gap-fill
 * carry-over) with the vsk=6 bundle / vsk=9 tombstone sub-kind convention.
 * No `v` tag: CORD-05 defines none, and the token→locator derivation is the
 * version discriminator.
 */

import { bytesToHex } from "@noble/hashes/utils.js";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";

import { open as cipherOpen, seal as cipherSeal } from "@/lib/concord/cipher";
import { KIND_APPLICATION_SPECIFIC } from "@/lib/concord/kinds";
import { PublicInviteError, type PublicInvitePreview } from "@/lib/concord/publicInvite";
import type { Community } from "@/lib/concord/types";
import { buildCordInvite, isCordInvite, type CordInvite } from "@/lib/cord/community";
import { cordInviteKey, cordInviteLocator, cordInviteSigner } from "@/lib/cord/derive";

const TAG_SUBKIND = "vsk";
const VSK_PUBLIC_INVITE = "6";
const VSK_PUBLIC_INVITE_REVOKED = "9";

/** The plaintext inside a CORD invite bundle event. */
export interface CordInviteBundle {
  preview: PublicInvitePreview;
  join: CordInvite;
  expires_at?: number;
  creator_npub?: string;
  label?: string;
}

export function isCordBundleExpired(bundle: CordInviteBundle, nowSecs: number): boolean {
  return bundle.expires_at !== undefined && nowSecs >= bundle.expires_at;
}

/** The addressable `d`-tag (hex locator) a CORD invite for `token` is posted under. */
export function cordLocatorHex(token: Uint8Array): string {
  return bytesToHex(cordInviteLocator(token));
}

/** The pubkey (hex) a valid CORD bundle for `token` must be signed by. */
export function cordSignerPubkey(token: Uint8Array): string {
  return getPublicKey(cordInviteSigner(token));
}

/** Build the signed, token-encrypted CORD bundle event (kind 30078 at the locator). */
export function buildCordInviteEvent(
  community: Community,
  token: Uint8Array,
  opts: { expiresAt?: number; creatorNpub?: string; label?: string } = {},
): NostrEvent {
  const bundle: CordInviteBundle = {
    preview: { name: community.name, description: community.description },
    join: buildCordInvite(community),
    expires_at: opts.expiresAt,
    creator_npub: opts.creatorNpub,
    label: opts.label,
  };
  const content = cipherSeal(cordInviteKey(token), JSON.stringify(bundle));
  return finalizeEvent(
    {
      kind: KIND_APPLICATION_SPECIFIC,
      content,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", cordLocatorHex(token)],
        [TAG_SUBKIND, VSK_PUBLIC_INVITE],
      ],
    },
    cordInviteSigner(token),
  );
}

/** Build a token-signed revocation tombstone at the CORD bundle's coordinate. */
export function buildCordInviteTombstone(token: Uint8Array): NostrEvent {
  return finalizeEvent(
    {
      kind: KIND_APPLICATION_SPECIFIC,
      content: "",
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", cordLocatorHex(token)],
        [TAG_SUBKIND, VSK_PUBLIC_INVITE_REVOKED],
      ],
    },
    cordInviteSigner(token),
  );
}

/**
 * Verify + decrypt a CORD bundle event with the URL token: signer match
 * (rejects a locator squatter) → Schnorr signature → sub-kind → decrypt →
 * structural check. Expiry is reported, not enforced (callers gate joins).
 */
export function parseCordInviteEvent(event: NostrEvent, token: Uint8Array): CordInviteBundle {
  if (event.pubkey !== cordSignerPubkey(token)) {
    throw new PublicInviteError("unexpected-signer", "bundle not signed by the invite token");
  }
  if (!verifyEvent(event)) throw new PublicInviteError("bad-signature", "bundle signature invalid");
  const subkind = event.tags.find((t) => t[0] === TAG_SUBKIND)?.[1];
  if (subkind === VSK_PUBLIC_INVITE_REVOKED) {
    throw new PublicInviteError("revoked", "this invite was revoked");
  }
  if (subkind !== VSK_PUBLIC_INVITE) {
    throw new PublicInviteError("wrong-subkind", `not a CORD invite bundle: ${subkind}`);
  }
  let plaintext: string;
  try {
    plaintext = cipherOpen(cordInviteKey(token), event.content);
  } catch (e) {
    throw new PublicInviteError("cipher", `cipher: ${e instanceof Error ? e.message : e}`);
  }
  let bundle: CordInviteBundle;
  try {
    bundle = JSON.parse(plaintext) as CordInviteBundle;
  } catch (e) {
    throw new PublicInviteError("json", `json: ${e instanceof Error ? e.message : e}`);
  }
  if (!bundle || typeof bundle !== "object" || !isCordInvite(bundle.join)) {
    throw new PublicInviteError("json", "bundle is not a CORD invite");
  }
  return bundle;
}
