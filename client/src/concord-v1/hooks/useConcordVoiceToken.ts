import { useQuery } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { fetchVoiceToken } from "@/concord-v1/lib/voice";
import type { Channel, Community } from "@/concord-v1/lib/types";

import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * Request a LiveKit JWT for a Concord channel's serverless voice room from a
 * blind broker. The grant is self-signed by the channel's per-epoch voice key
 * (proving key possession), so the broker authorizes without learning the
 * community. Like the NIP-29 token, this must stay STABLE for the call's
 * lifetime — a refetch would mint a fresh random identity and churn the
 * connection — so all auto-refetch is disabled.
 */
export function useConcordVoiceToken(
  community: Community | undefined,
  channel: Channel | undefined,
  voiceServer: string | undefined,
  enabled: boolean,
) {
  const { user } = useCurrentUser();
  const channelIdHex = channel ? bytesToHex(channel.id) : null;

  return useQuery({
    queryKey: ["concord", "voice-token", channelIdHex, channel ? channel.epoch.toString() : null, voiceServer, user?.pubkey],
    queryFn: async () => {
      if (!user) throw new Error("Not logged in");
      if (!channel || !voiceServer) throw new Error("No voice room");
      return fetchVoiceToken(channel, voiceServer, user.pubkey);
    },
    enabled: enabled && Boolean(user && community && channel && voiceServer),
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  });
}
