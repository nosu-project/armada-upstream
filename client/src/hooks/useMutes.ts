import { useCallback, useMemo } from "react";

import { channelReadKey } from "@/contexts/ReadStateContext";
import { useAppContext } from "@/hooks/useAppContext";
import { normalizeRelayUrl } from "@/lib/platform";

/**
 * Stable mute key for a community: a normalized relay URL for NIP-29 servers,
 * `c1:${communityId}` / `c2:${communityId}` for Concord — the same stable key
 * scheme the server rail uses (`railOrder` / `railLayout`).
 */
export function communityMuteKey(relayUrlOrRailKey: string): string {
  if (relayUrlOrRailKey.startsWith("c1:") || relayUrlOrRailKey.startsWith("c2:")) {
    return relayUrlOrRailKey;
  }
  return normalizeRelayUrl(relayUrlOrRailKey) ?? relayUrlOrRailKey;
}

/**
 * Stable mute key for a NIP-29 channel: `${relayUrl}::${groupId}` — the same
 * key scheme as the read state, with the relay URL normalized so a mute set
 * from one surface (route param, group list, rail) matches everywhere.
 */
export function channelMuteKey(relayUrl: string, groupId: string): string {
  return channelReadKey(normalizeRelayUrl(relayUrl) ?? relayUrl, groupId);
}

/**
 * Stable mute key for a Concord channel:
 * `c1:${communityId}::${channelIdHex}` / `c2:${communityId}::${channelIdHex}`
 * — the community's rail key plus the channel id, mirroring the NIP-29
 * `${relayUrl}::${groupId}` shape.
 */
export function concordChannelMuteKey(
  protocol: "c1" | "c2",
  communityId: string,
  channelIdHex: string,
): string {
  return `${protocol}:${communityId}::${channelIdHex}`;
}

export interface UseMutesReturn {
  /** Muted community keys (rail keys). */
  mutedCommunities: Set<string>;
  /** Muted channel keys (`${relayUrl}::${groupId}`). */
  mutedChannels: Set<string>;
  /** Whether a community (server / Concord community) is muted. */
  isCommunityMuted: (railKey: string) => boolean;
  /**
   * Whether a NIP-29 channel is muted — either individually or because its
   * whole server is muted.
   */
  isChannelMuted: (relayUrl: string, groupId: string) => boolean;
  /**
   * Whether a Concord channel is muted — either individually or because its
   * whole community is muted.
   */
  isConcordChannelMuted: (
    protocol: "c1" | "c2",
    communityId: string,
    channelIdHex: string,
  ) => boolean;
  /** Toggle a community mute (by rail key). */
  toggleCommunityMute: (railKey: string) => void;
  /** Toggle an individual channel mute. */
  toggleChannelMute: (relayUrl: string, groupId: string) => void;
  /** Toggle an individual Concord channel mute. */
  toggleConcordChannelMute: (
    protocol: "c1" | "c2",
    communityId: string,
    channelIdHex: string,
  ) => void;
}

/**
 * Per-community / per-channel notification mutes.
 *
 * Muting silences notifications (web push, native background service) and
 * suppresses the unread badge for the muted scope without leaving it — unread
 * mentions still badge, Discord-style. Stored in AppConfig
 * (`mutedCommunities` / `mutedChannels`) and synced across devices via the
 * encrypted settings event.
 */
export function useMutes(): UseMutesReturn {
  const { config, updateConfig } = useAppContext();

  const mutedCommunities = useMemo(
    () => new Set(config.mutedCommunities.map(communityMuteKey)),
    [config.mutedCommunities],
  );
  const mutedChannels = useMemo(
    () => new Set(config.mutedChannels),
    [config.mutedChannels],
  );

  const isCommunityMuted = useCallback(
    (railKey: string) => mutedCommunities.has(communityMuteKey(railKey)),
    [mutedCommunities],
  );

  const isChannelMuted = useCallback(
    (relayUrl: string, groupId: string) =>
      mutedChannels.has(channelMuteKey(relayUrl, groupId)) ||
      mutedCommunities.has(communityMuteKey(relayUrl)),
    [mutedChannels, mutedCommunities],
  );

  const isConcordChannelMuted = useCallback(
    (protocol: "c1" | "c2", communityId: string, channelIdHex: string) =>
      mutedChannels.has(concordChannelMuteKey(protocol, communityId, channelIdHex)) ||
      mutedCommunities.has(`${protocol}:${communityId}`),
    [mutedChannels, mutedCommunities],
  );

  const toggleCommunityMute = useCallback(
    (railKey: string) => {
      const key = communityMuteKey(railKey);
      updateConfig((current) => {
        const set = new Set(current.mutedCommunities.map(communityMuteKey));
        if (set.has(key)) set.delete(key);
        else set.add(key);
        return { ...current, mutedCommunities: [...set].sort() };
      });
    },
    [updateConfig],
  );

  const toggleChannelMute = useCallback(
    (relayUrl: string, groupId: string) => {
      const key = channelMuteKey(relayUrl, groupId);
      updateConfig((current) => {
        const set = new Set(current.mutedChannels);
        if (set.has(key)) set.delete(key);
        else set.add(key);
        return { ...current, mutedChannels: [...set].sort() };
      });
    },
    [updateConfig],
  );

  const toggleConcordChannelMute = useCallback(
    (protocol: "c1" | "c2", communityId: string, channelIdHex: string) => {
      const key = concordChannelMuteKey(protocol, communityId, channelIdHex);
      updateConfig((current) => {
        const set = new Set(current.mutedChannels);
        if (set.has(key)) set.delete(key);
        else set.add(key);
        return { ...current, mutedChannels: [...set].sort() };
      });
    },
    [updateConfig],
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
