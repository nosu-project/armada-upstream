/**
 * Concord control-plane metadata CONTENT structs — ported from Vector's
 * `community/metadata.rs`.
 *
 * `CommunityMetadata` (GroupRoot, vsk=0) and `ChannelMetadata` (vsk=2) are the
 * decrypted content of real-npub-signed kind-3308 control editions, built by the
 * builders in `control.ts` and folded by the per-entity version chain. The wire
 * shape mirrors Vector's serde so the control plane is cross-readable.
 */

import type { CommunityImage, Community } from "@/lib/concord/types";

/** Community-level descriptor (the "GroupRoot" entity, vsk=0). */
export interface CommunityMetadata {
  name: string;
  /** Preferred relay set — also bootstrapped via the invite. */
  relays: string[];
  /** Short description / topic. */
  description?: string;
  /** Logo (encrypted blob ref; key rides in this ServerRoot-sealed content). */
  icon?: CommunityImage;
  /** Banner (encrypted blob ref). */
  banner?: CommunityImage;
  /** Owner attestation (signed event JSON) — lets members verify the owner via the GroupRoot too. */
  owner_attestation?: string;
}

/** The GroupRoot descriptor for a Community — the content of its vsk=0 control edition. */
export function communityMetadataOf(c: Community): CommunityMetadata {
  return {
    name: c.name,
    relays: c.relays,
    ...(c.description !== undefined ? { description: c.description } : {}),
    ...(c.icon !== undefined ? { icon: c.icon } : {}),
    ...(c.banner !== undefined ? { banner: c.banner } : {}),
    ...(c.ownerAttestation !== undefined ? { owner_attestation: c.ownerAttestation } : {}),
  };
}

/** Channel-level descriptor (vsk=2). */
export interface ChannelMetadata {
  name: string;
}
