import { createContext, useContext } from "react";

import { pubkeyFromLivekitIdentity } from "@/hooks/useLivekit";

/**
 * How a LiveKit participant identity maps to a Nostr pubkey for display.
 *
 * NIP-29 / DM rooms embed the pubkey in the identity itself
 * (`<64-hex-pubkey>-<rand>`), so the default resolver just extracts it and
 * every participant is trivially "verified".
 *
 * Concord AV rooms (CORD-07) assign fully-random identities, and the mapping
 * comes from signed presence instead: a participant resolves to a member only
 * when exactly ONE author's fresh presence claims that identity (§4). A
 * contested or unclaimed identity is UNVERIFIED — the call UI shows it as
 * such, and the room withholds its media key so unverified tracks don't
 * render (§7).
 */
export interface VoiceIdentityInfo {
  /** The pubkey to render the participant as (a stable fallback when unverified). */
  pubkey: string;
  /** Whether the mapping is proven (identity-embedded, or a sole fresh presence claim). */
  verified: boolean;
}

export type VoiceIdentityResolver = (identity: string) => VoiceIdentityInfo;

const defaultResolver: VoiceIdentityResolver = (identity) => ({
  pubkey: pubkeyFromLivekitIdentity(identity),
  verified: true,
});

export const VoiceIdentityContext = createContext<VoiceIdentityResolver>(defaultResolver);

/** Resolve a LiveKit identity to its display pubkey + verification state. */
export function useVoiceIdentity(): VoiceIdentityResolver {
  return useContext(VoiceIdentityContext);
}
