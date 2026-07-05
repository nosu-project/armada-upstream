/**
 * Owner attestation — ported from Vector's `community/owner.rs`.
 *
 * At creation the owner signs, with their identity key, a statement binding the
 * community's random id. The proven owner is DERIVED from the signature
 * (event.pubkey), never asserted separately — so you can't frame an innocent
 * npub, and the binding can't be transplanted to another community.
 */

import { finalizeEvent, verifyEvent } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";

import { KIND_APPLICATION_SPECIFIC } from "@/concord-v1/lib/kinds";

const TAG_OWNER = "vco";

/** The unsigned owner-attestation event. Sign with the owner's identity signer. */
export function buildOwnerAttestationUnsigned(communityIdHex: string): EventTemplate {
  return {
    kind: KIND_APPLICATION_SPECIFIC,
    content: "",
    tags: [[TAG_OWNER, communityIdHex]],
    created_at: Math.floor(Date.now() / 1000),
  };
}

/** Sign the owner attestation with the owner's local secret key. */
export function signOwnerAttestation(template: EventTemplate, ownerSk: Uint8Array): NostrEvent {
  return finalizeEvent(template, ownerSk);
}

/**
 * Verify an owner-attestation event (JSON). Returns the PROVEN owner pubkey
 * (hex) iff the signature is valid AND it binds exactly this communityId;
 * undefined on any missing/mismatched/forged input.
 */
export function verifyOwnerAttestation(attestationJson: string, communityIdHex: string): string | undefined {
  let ev: NostrEvent;
  try {
    ev = JSON.parse(attestationJson) as NostrEvent;
  } catch {
    return undefined;
  }
  if (!ev || typeof ev !== "object" || !verifyEvent(ev)) return undefined;
  const bound = ev.tags?.find((t) => t[0] === TAG_OWNER)?.[1];
  return bound === communityIdHex ? ev.pubkey : undefined;
}
