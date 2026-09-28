import { useCallback, useMemo } from "react";

import { channelReadKey } from "@/contexts/ReadStateContext";
import { useAppContext } from "@/hooks/useAppContext";
import { DEFAULT_PUSH_PREFS, type PushPrefs } from "@/lib/pushPrefs";
import { normalizeRelayUrl } from "@/lib/platform";

/**
 * Per-conversation notification levels (Discord model): all / mentions / nothing.
 * Channel cascade: channel → community → global prefs (`allGroupMessages` ⇒ all, else `mentions`
 * ⇒ mentions, else nothing). DMs (`mentions` ≡ `all`) fall back to `directMessages`.
 * Stored in `AppConfig.notifLevels` under the mute scope keys; legacy
 * `mutedCommunities`/`mutedChannels` read as `nothing`.
 */

export type NotifLevel = "all" | "mentions" | "nothing";

// Stable scope keys (same scheme as useMutes).

export function communityScopeKey(relayUrlOrRailKey: string): string {
  if (relayUrlOrRailKey.startsWith("c2:")) {
    return relayUrlOrRailKey;
  }
  return normalizeRelayUrl(relayUrlOrRailKey) ?? relayUrlOrRailKey;
}

export function channelScopeKey(relayUrl: string, groupId: string): string {
  return channelReadKey(normalizeRelayUrl(relayUrl) ?? relayUrl, groupId);
}

export function concordChannelScopeKey(
  protocol: "c2",
  communityId: string,
  channelIdHex: string,
): string {
  return `${protocol}:${communityId}::${channelIdHex}`;
}

export function dmScopeKey(pubkey: string): string {
  return `dm:${pubkey}`;
}

function globalChannelLevel(prefs: PushPrefs): NotifLevel {
  if (prefs.allGroupMessages) return "all";
  if (prefs.mentions) return "mentions";
  return "nothing";
}

function globalDmLevel(prefs: PushPrefs): NotifLevel {
  return prefs.directMessages ? "all" : "nothing";
}

export interface UseNotifLevelsReturn {
  /** Explicit level, or undefined (inherit). */
  getLevel: (scopeKey: string) => NotifLevel | undefined;
  setLevel: (scopeKey: string, level: NotifLevel | undefined) => void;
  /** Resolved via channel → server → global. */
  channelLevel: (relayUrl: string, groupId: string) => NotifLevel;
  /** Channel → community → global. */
  concordChannelLevel: (
    protocol: "c2",
    communityId: string,
    channelIdHex: string,
  ) => NotifLevel;
  communityLevel: (railKey: string) => NotifLevel;
  dmLevel: (pubkey: string) => NotifLevel;
}

function effectiveMap(
  levels: Record<string, NotifLevel>,
  mutedCommunities: string[],
  mutedChannels: string[],
): Map<string, NotifLevel> {
  const m = new Map<string, NotifLevel>();
  // Legacy mutes first (lowest precedence).
  for (const key of mutedCommunities) m.set(communityScopeKey(key), "nothing");
  for (const key of mutedChannels) m.set(key, "nothing");
  for (const [key, level] of Object.entries(levels)) m.set(key, level);
  return m;
}

export function useNotifLevels(): UseNotifLevelsReturn {
  const { config, updateConfig } = useAppContext();
  // Account-scoped AppConfig only; never another account's legacy localStorage mirror.
  const pushPrefs = config.pushPrefs ?? DEFAULT_PUSH_PREFS;

  const map = useMemo(
    () => effectiveMap(config.notifLevels, config.mutedCommunities, config.mutedChannels),
    [config.notifLevels, config.mutedCommunities, config.mutedChannels],
  );

  const getLevel = useCallback((scopeKey: string) => map.get(scopeKey), [map]);

  const setLevel = useCallback(
    (scopeKey: string, level: NotifLevel | undefined) => {
      updateConfig((current) => {
        const nextLevels = { ...current.notifLevels };
        if (level === undefined) delete nextLevels[scopeKey];
        else nextLevels[scopeKey] = level;

        // Keep legacy mute sets in lock-step for older clients and the push gateway (`muted_groups`).
        // Channel keys contain `::`; `dm:` keys belong to neither set.
        const isChannel = scopeKey.includes("::");
        const isDm = scopeKey.startsWith("dm:");
        const muteSetKey: "mutedCommunities" | "mutedChannels" | null = isDm
          ? null
          : isChannel
            ? "mutedChannels"
            : "mutedCommunities";

        if (muteSetKey) {
          const muteSet = new Set(current[muteSetKey]);
          if (level === "nothing") muteSet.add(scopeKey);
          else muteSet.delete(scopeKey);
          return {
            ...current,
            notifLevels: nextLevels,
            [muteSetKey]: [...muteSet].sort(),
          };
        }
        return { ...current, notifLevels: nextLevels };
      });
    },
    [updateConfig],
  );

  const communityLevel = useCallback(
    (railKey: string): NotifLevel => {
      const explicit = map.get(communityScopeKey(railKey));
      return explicit ?? globalChannelLevel(pushPrefs);
    },
    [map, pushPrefs],
  );

  const channelLevel = useCallback(
    (relayUrl: string, groupId: string): NotifLevel => {
      const own = map.get(channelScopeKey(relayUrl, groupId));
      if (own) return own;
      const server = map.get(communityScopeKey(relayUrl));
      if (server) return server;
      return globalChannelLevel(pushPrefs);
    },
    [map, pushPrefs],
  );

  const concordChannelLevel = useCallback(
    (protocol: "c2", communityId: string, channelIdHex: string): NotifLevel => {
      const own = map.get(concordChannelScopeKey(protocol, communityId, channelIdHex));
      if (own) return own;
      const community = map.get(`${protocol}:${communityId}`);
      if (community) return community;
      return globalChannelLevel(pushPrefs);
    },
    [map, pushPrefs],
  );

  const dmLevel = useCallback(
    (pubkey: string): NotifLevel => {
      const own = map.get(dmScopeKey(pubkey));
      return own ?? globalDmLevel(pushPrefs);
    },
    [map, pushPrefs],
  );

  return {
    getLevel,
    setLevel,
    channelLevel,
    concordChannelLevel,
    communityLevel,
    dmLevel,
  };
}
