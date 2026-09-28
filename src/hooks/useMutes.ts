import { useCallback, useMemo } from "react";

import { channelReadKey } from "@/contexts/ReadStateContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useNotifLevels } from "@/hooks/useNotifLevels";
import { normalizeRelayUrl } from "@/lib/platform";

/** Normalized relay URL for NIP-29, `c2:${communityId}` for Concord — the rail key scheme. */
export function communityMuteKey(relayUrlOrRailKey: string): string {
  if (relayUrlOrRailKey.startsWith("c2:")) {
    return relayUrlOrRailKey;
  }
  return normalizeRelayUrl(relayUrlOrRailKey) ?? relayUrlOrRailKey;
}

/** `${relayUrl}::${groupId}` with the URL normalized, like read state. */
export function channelMuteKey(relayUrl: string, groupId: string): string {
  return channelReadKey(normalizeRelayUrl(relayUrl) ?? relayUrl, groupId);
}

/** `c2:${communityId}::${channelIdHex}`, mirroring the NIP-29 shape. */
export function concordChannelMuteKey(
  protocol: "c2",
  communityId: string,
  channelIdHex: string,
): string {
  return `${protocol}:${communityId}::${channelIdHex}`;
}

export interface UseMutesReturn {
  mutedCommunities: Set<string>;
  mutedChannels: Set<string>;
  isCommunityMuted: (railKey: string) => boolean;
  /** Individually or via its whole server. */
  isChannelMuted: (relayUrl: string, groupId: string) => boolean;
  /** Individually or via its whole community. */
  isConcordChannelMuted: (
    protocol: "c2",
    communityId: string,
    channelIdHex: string,
  ) => boolean;
  toggleCommunityMute: (railKey: string) => void;
  toggleChannelMute: (relayUrl: string, groupId: string) => void;
  toggleConcordChannelMute: (
    protocol: "c2",
    communityId: string,
    channelIdHex: string,
  ) => void;
}

/**
 * Compatibility facade over {@link useNotifLevels}: "muted" is the `nothing` level. `is*Muted`
 * reports an effective `nothing`; toggles flip between `nothing` and inherit.
 */
export function useMutes(): UseMutesReturn {
  const { config } = useAppContext();
  const { getLevel, setLevel } = useNotifLevels();

  const mutedCommunities = useMemo(
    () => new Set(config.mutedCommunities.map(communityMuteKey)),
    [config.mutedCommunities],
  );
  const mutedChannels = useMemo(
    () => new Set(config.mutedChannels),
    [config.mutedChannels],
  );

  // Explicit `nothing` at the scope or inherited from the community — NOT the global-prefs
  // fallback, so turning off a global toggle never silences every badge.
  const isCommunityMuted = useCallback(
    (railKey: string) => getLevel(communityMuteKey(railKey)) === "nothing",
    [getLevel],
  );

  const isChannelMuted = useCallback(
    (relayUrl: string, groupId: string) =>
      getLevel(channelMuteKey(relayUrl, groupId)) === "nothing" ||
      getLevel(communityMuteKey(relayUrl)) === "nothing",
    [getLevel],
  );

  const isConcordChannelMuted = useCallback(
    (protocol: "c2", communityId: string, channelIdHex: string) =>
      getLevel(concordChannelMuteKey(protocol, communityId, channelIdHex)) === "nothing" ||
      getLevel(`${protocol}:${communityId}`) === "nothing",
    [getLevel],
  );

  const toggleCommunityMute = useCallback(
    (railKey: string) => {
      const key = communityMuteKey(railKey);
      setLevel(key, getLevel(key) === "nothing" ? undefined : "nothing");
    },
    [setLevel, getLevel],
  );

  const toggleChannelMute = useCallback(
    (relayUrl: string, groupId: string) => {
      const key = channelMuteKey(relayUrl, groupId);
      setLevel(key, getLevel(key) === "nothing" ? undefined : "nothing");
    },
    [setLevel, getLevel],
  );

  const toggleConcordChannelMute = useCallback(
    (protocol: "c2", communityId: string, channelIdHex: string) => {
      const key = concordChannelMuteKey(protocol, communityId, channelIdHex);
      setLevel(key, getLevel(key) === "nothing" ? undefined : "nothing");
    },
    [setLevel, getLevel],
  );

  return {
    mutedCommunities,
    mutedChannels,
    isCommunityMuted,
    isChannelMuted,
    isConcordChannelMuted,
    toggleCommunityMute,
    toggleChannelMute,
    toggleConcordChannelMute,
  };
}
