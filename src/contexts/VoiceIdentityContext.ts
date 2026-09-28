import { createContext, useContext } from "react";

import { pubkeyFromLivekitIdentity } from "@/hooks/useLivekit";

/**
 * How a LiveKit identity maps to a pubkey for display. NIP-29/DM identities embed
 * it (`<64-hex-pubkey>-<rand>`). Concord (CORD-07) identities are random: a member
 * only when exactly ONE fresh presence claims it (§4); otherwise UNVERIFIED and
 * its media key withheld (§7).
 */
export interface VoiceIdentityInfo {
  /** The pubkey to render the participant as (a stable fallback when unverified). */
  pubkey: string;
  /** Whether the mapping is proven (identity-embedded, or a sole fresh presence claim). */
  verified: boolean;
  /** Signed role for auxiliary media identities; ordinary callers are members. */
  role: "member" | "screen-share";
}

export type VoiceIdentityResolver = (identity: string) => VoiceIdentityInfo;

const defaultResolver: VoiceIdentityResolver = (identity) => ({
  pubkey: pubkeyFromLivekitIdentity(identity),
  verified: true,
  role: "member",
});

export const VoiceIdentityContext = createContext<VoiceIdentityResolver>(defaultResolver);

/** Resolve a LiveKit identity to its display pubkey + verification state. */
export function useVoiceIdentity(): VoiceIdentityResolver {
  return useContext(VoiceIdentityContext);
}
