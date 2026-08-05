import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  buildRelayListTags,
  discoverRelayList,
  KIND_RELAY_LIST,
  publishRelayListEvent,
  type RelayListDiscovery,
  type RelayListPublishResult,
  type RelayPreference,
  uniqueRelayUrls,
} from "@/lib/nip65";
import { RELAY_LIST_DISCOVERY_RELAYS } from "@/lib/platform";
import { publishTimeoutMs } from "@/lib/publishTimeout";

/**
 * Discover, adopt and explicitly publish the logged-in user's NIP-65 list.
 * Discovery never signs. Publishing signs one event and fans those exact bytes
 * to every declared/app/discovery relay, so replaceable-event ordering cannot
 * diverge across destinations.
 */
export function useNip65RelaySetup() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const queryClient = useQueryClient();

  const discoveryRelays = useMemo(
    () => uniqueRelayUrls([...config.appRelays, ...RELAY_LIST_DISCOVERY_RELAYS]),
    [config.appRelays],
  );

  const adopt = useCallback((discovery: RelayListDiscovery) => {
    updateConfig((current) => {
      const sameOwner = current.relayMetadata.pubkey === user?.pubkey;
      if (sameOwner && discovery.event.created_at <= current.relayMetadata.updatedAt) return current;
      return {
        ...current,
        useUserRelays: true,
        relayMetadata: {
          relays: discovery.relays,
          updatedAt: discovery.event.created_at,
          pubkey: user?.pubkey,
        },
      };
    });
    // The general pool changes on the next render. Invalidate the self-owned
    // caches then; their refetches and NostrSync's restarted standing REQ will
    // ask the newly-adopted relays.
    setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ["encrypted-settings", user?.pubkey] });
      queryClient.invalidateQueries({ queryKey: ["nip29", "user-groups", user?.pubkey] });
      queryClient.invalidateQueries({ queryKey: ["dm-relay-list"] });
    }, 0);
  }, [queryClient, updateConfig, user?.pubkey]);

  const discover = useCallback(async (bootstrapRelays: string[] = []) => {
    if (!user) throw new Error("User is not logged in");
    return discoverRelayList(
      nostr,
      user.pubkey,
      uniqueRelayUrls([...bootstrapRelays, ...discoveryRelays]),
      AbortSignal.timeout(8_000),
    );
  }, [discoveryRelays, nostr, user]);

  const publish = useCallback(async (relays: RelayPreference[]): Promise<RelayListPublishResult> => {
    if (!user) throw new Error("User is not logged in");
    const tags = buildRelayListTags(relays);
    if (tags.length === 0) throw new Error("Add at least one valid relay");

    const createdAt = Math.max(
      Math.floor(Date.now() / 1000),
      config.relayMetadata.pubkey === user.pubkey
        ? config.relayMetadata.updatedAt + 1
        : 0,
    );
    const event = await user.signer.signEvent({
      kind: KIND_RELAY_LIST,
      content: "",
      tags,
      created_at: createdAt,
    });
    if (event.pubkey !== user.pubkey) {
      throw new Error("The signer returned a different account");
    }

    const declared = tags.map((tag) => tag[1]).filter((url): url is string => Boolean(url));
    const targets = uniqueRelayUrls([
      ...declared,
      ...config.appRelays,
      ...RELAY_LIST_DISCOVERY_RELAYS,
    ]);
    const timeout = publishTimeoutMs(user.method);
    const result = await publishRelayListEvent(nostr, event, targets, timeout);
    if (result.accepted.length === 0) {
      throw new Error("No relay accepted your signed relay list");
    }

    adopt({ event, relays: tags.map((tag) => ({
      url: tag[1]!,
      read: tag[2] !== "write",
      write: tag[2] !== "read",
    })) });
    return result;
  }, [adopt, config.appRelays, config.relayMetadata.pubkey, config.relayMetadata.updatedAt, nostr, user]);

  return {
    discoveryRelays,
    discover,
    adopt,
    publish,
  };
}
