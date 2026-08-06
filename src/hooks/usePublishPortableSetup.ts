import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { accountDataRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import {
  KIND_BLOSSOM_SERVERS,
  type BlossomServerListQuery,
} from "@/hooks/useBlossomServerList";
import {
  KIND_DM_RELAYS,
  parseDmRelays,
  type DmRelayListQuery,
} from "@/hooks/useDmRelayList";
import { getLocalSettingsSync, setLocalSettingsSync } from "@/hooks/useEncryptedSettings";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { parseBlossomServerList } from "@/lib/blossom";
import { KIND_USER_GROUPS } from "@/lib/nip29";
import {
  KIND_RELAY_LIST,
  newestRelayList,
  publishSignedEventToRelays,
  queryExplicitRelays,
  uniqueRelayUrls,
} from "@/lib/nip65";
import { APP_NAME, RELAY_LIST_DISCOVERY_RELAYS } from "@/lib/platform";
import { EncryptedSettingsSchema, type EncryptedSettings } from "@/lib/schemas";
import {
  KIND_SEARCH_RELAYS,
  readSearchRelayList,
} from "@/lib/searchRelayList";
import type { SearchRelayListQuery } from "@/hooks/useSearchRelayList";
import { syncedConfigSnapshot } from "@/lib/syncedConfig";

import type { NostrEvent } from "@nostrify/nostrify";

const SETTINGS_KIND = 30078;
const SETTINGS_D = "armada/metadata";
const PUBLISH_TIMEOUT_MS = 8_000;

export interface PortableSetupPublishResult {
  records: number;
  destinations: number;
  rejectedDeliveries: number;
}

function newest(events: NostrEvent[], kind: number): NostrEvent | undefined {
  return events
    .filter((event) => event.kind === kind)
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
}

function nextCreatedAt(prev: NostrEvent | undefined): number {
  const now = Math.floor(Date.now() / 1000);
  return prev ? Math.max(now, prev.created_at + 1) : now;
}

/**
 * Explicitly make the current account setup recoverable from every NIP-65
 * write relay. Existing signed list events are mirrored byte-for-byte; a
 * missing canonical service list is created only when the user has a non-empty
 * value in Settings. Armada's private preferences are merged into the latest
 * decryptable NIP-78 document, never built over an ambiguous failed read.
 */
export function usePublishPortableSetup() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const queryClient = useQueryClient();
  const [isPending, setIsPending] = useState(false);

  const publish = useCallback(async (): Promise<PortableSetupPublishResult> => {
    if (!user) throw new Error("Not logged in");
    if (!user.signer.nip44) throw new Error("Your signer does not support encrypted settings");

    const ownsRelayList = config.relayMetadata.pubkey === user.pubkey;
    const targets = uniqueRelayUrls(
      ownsRelayList
        ? config.relayMetadata.relays
            .filter((relay) => relay.write)
            .map((relay) => relay.url)
        : [],
    );
    if (targets.length === 0) {
      throw new Error("Publish a NIP-65 write relay first");
    }

    setIsPending(true);
    try {
      const sources = uniqueRelayUrls([
        ...accountDataRelays(config, user.pubkey),
        ...targets,
        ...RELAY_LIST_DISCOVERY_RELAYS,
      ]);
      const events = await queryExplicitRelays(
        nostr,
        sources,
        [
          {
            kinds: [
              KIND_RELAY_LIST,
              KIND_SEARCH_RELAYS,
              KIND_USER_GROUPS,
              KIND_DM_RELAYS,
              KIND_BLOSSOM_SERVERS,
            ],
            authors: [user.pubkey],
          },
          {
            kinds: [SETTINGS_KIND],
            authors: [user.pubkey],
            "#d": [SETTINGS_D],
            limit: 1,
          },
        ],
        AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
      );

      const relayList = newestRelayList(events);
      if (!relayList) {
        throw new Error("Could not refresh your signed NIP-65 list; nothing was published");
      }

      const toPublish: NostrEvent[] = [relayList];
      const groupList = newest(events, KIND_USER_GROUPS);
      if (groupList) toPublish.push(groupList);

      let searchEvent = newest(events, KIND_SEARCH_RELAYS);
      if (!searchEvent && config.searchRelays.length > 0) {
        searchEvent = await user.signer.signEvent({
          kind: KIND_SEARCH_RELAYS,
          content: "",
          tags: config.searchRelays.map((relay) => ["relay", relay]),
          created_at: nextCreatedAt(undefined),
        });
      }
      if (searchEvent) toPublish.push(searchEvent);

      let dmEvent = newest(events, KIND_DM_RELAYS);
      if (!dmEvent && config.dmRelays.length > 0) {
        dmEvent = await user.signer.signEvent({
          kind: KIND_DM_RELAYS,
          content: "",
          tags: config.dmRelays.map((relay) => ["relay", relay]),
          created_at: nextCreatedAt(undefined),
        });
      }
      if (dmEvent) toPublish.push(dmEvent);

      let blossomEvent = newest(events, KIND_BLOSSOM_SERVERS);
      if (!blossomEvent && config.blossomServerMetadata.servers.length > 0) {
        blossomEvent = await user.signer.signEvent({
          kind: KIND_BLOSSOM_SERVERS,
          content: "",
          tags: config.blossomServerMetadata.servers.map((server) => ["server", server]),
          created_at: nextCreatedAt(undefined),
        });
      }
      if (blossomEvent) toPublish.push(blossomEvent);

      const previousSettings = events
        .filter((event) =>
          event.kind === SETTINGS_KIND
          && event.tags.some(([name, value]) => name === "d" && value === SETTINGS_D))
        .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
      if (!previousSettings && getLocalSettingsSync(user.pubkey) > 0) {
        throw new Error("Could not refresh your existing private settings; nothing was published");
      }

      let base: EncryptedSettings = {};
      if (previousSettings) {
        try {
          const plaintext = await user.signer.nip44.decrypt(user.pubkey, previousSettings.content);
          const parsed = EncryptedSettingsSchema.safeParse(JSON.parse(plaintext));
          if (!parsed.success) throw new Error("Invalid settings document");
          base = parsed.data;
        } catch {
          throw new Error("Could not decrypt your existing private settings; nothing was published");
        }
      }
      const nextSettings: EncryptedSettings = {
        ...base,
        ...syncedConfigSnapshot(config),
        lastSync: Date.now(),
      };
      const settingsContent = await user.signer.nip44.encrypt(
        user.pubkey,
        JSON.stringify(nextSettings),
      );
      const settingsEvent = await user.signer.signEvent({
        kind: SETTINGS_KIND,
        content: settingsContent,
        tags: previousSettings
          ? previousSettings.tags.filter(([name]) => name !== "client")
          : [["d", SETTINGS_D], ["title", `${APP_NAME} Settings`]],
        created_at: nextCreatedAt(previousSettings),
      });
      toPublish.push(settingsEvent);

      for (const event of toPublish) {
        if (event.pubkey !== user.pubkey) throw new Error("The signer returned a different account");
      }

      let rejectedDeliveries = 0;
      for (const event of toPublish) {
        const destinations = event.kind === KIND_RELAY_LIST
          ? uniqueRelayUrls([...targets, ...RELAY_LIST_DISCOVERY_RELAYS])
          : targets;
        const result = await publishSignedEventToRelays(
          nostr,
          event,
          destinations,
          PUBLISH_TIMEOUT_MS,
        );
        rejectedDeliveries += result.rejected.length;
        if (result.accepted.length === 0) {
          throw new Error(`No relay accepted setup record kind ${event.kind}`);
        }
      }

      if (searchEvent) {
        queryClient.setQueryData<SearchRelayListQuery>(
          ["search-relay-list", user.pubkey],
          { event: searchEvent, ...(await readSearchRelayList(searchEvent, user.signer)) },
        );
      }
      if (dmEvent) {
        queryClient.setQueryData<DmRelayListQuery>(["dm-relay-list", user.pubkey], {
          event: dmEvent,
          relays: parseDmRelays(dmEvent),
        });
      }
      if (blossomEvent) {
        const servers = parseBlossomServerList(blossomEvent);
        queryClient.setQueryData<BlossomServerListQuery>(
          ["blossom-server-list", user.pubkey],
          { event: blossomEvent, servers },
        );
        updateConfig((current) => ({
          ...current,
          blossomServerMetadata: { servers, updatedAt: blossomEvent!.created_at },
        }));
      }
      queryClient.setQueryData(["encrypted-settings", user.pubkey], nextSettings);
      setLocalSettingsSync(user.pubkey, nextSettings.lastSync ?? Date.now());

      return {
        records: toPublish.length,
        destinations: targets.length,
        rejectedDeliveries,
      };
    } finally {
      setIsPending(false);
    }
  }, [config, nostr, queryClient, updateConfig, user]);

  return { publish, isPending };
}
