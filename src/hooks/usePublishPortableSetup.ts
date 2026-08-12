import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { selfStateRelays } from "@/contexts/AppContext";
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
import {
  decodeSettingsDoc,
  nextSettingsDoc,
  readSettingsDoc,
  settingsDocQueryKey,
  useSettingsDoc,
} from "@/hooks/useSettingsDoc";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
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
import {
  KIND_SEARCH_RELAYS,
  readSearchRelayList,
} from "@/lib/searchRelayList";
import type { SearchRelayListQuery } from "@/hooks/useSearchRelayList";
import {
  SETTINGS_DOC_NAMES,
  SETTINGS_DTAGS,
  SETTINGS_KIND,
  settingsDTag,
  type SettingsDocName,
} from "@/lib/settingsDocs";
import { CONFIG_KEYS_BY_DOC, configSnapshot, type ConfigDocName } from "@/lib/syncedConfig";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

const PUBLISH_TIMEOUT_MS = 8_000;

export interface PortableSetupPublishResult {
  records: number;
  destinations: number;
  rejectedDeliveries: number;
  /**
   * Settings documents that exist on this device but that no relay returned,
   * and so were left alone. Rebuilding one from a base we couldn't confirm
   * would silently drop whatever the local copy is missing.
   */
  unrefreshed: SettingsDocName[];
}

function newest(events: NostrEvent[], kind: number): NostrEvent | undefined {
  return events
    .filter((event) => event.kind === kind)
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
}

function nextCreatedAt(prev: NostrRumor | undefined): number {
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
  const eventStore = useEventStore();
  const [isPending, setIsPending] = useState(false);
  const metadataDoc = useSettingsDoc("metadata");
  const ownsRelayList = !!user && config.relayMetadata.pubkey === user.pubkey;
  const hasSyncRelay = ownsRelayList
    && config.relayMetadata.relays.some((relay) => relay.write);
  const isConfigured = Boolean(user?.signer.nip44 && metadataDoc.doc && hasSyncRelay);
  const isAutomatic = isConfigured && config.automaticSettingsSync !== false;

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
        ...selfStateRelays(config, user.pubkey),
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
            "#d": SETTINGS_DTAGS,
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

      // Each of the six settings documents, handled independently. A document
      // this account has never written simply isn't there, which is not a
      // failure — but one that exists locally and came back from NO relay is,
      // and is skipped rather than rebuilt from a base we can't confirm.
      const store = await eventStore;
      const settingsSeeds: { name: SettingsDocName; event: NostrEvent; doc: unknown }[] = [];
      const unrefreshed: SettingsDocName[] = [];

      for (const name of SETTINGS_DOC_NAMES) {
        // The relays' newest copy and ArmadaDB's compete. The store is where
        // the standing self-state REQ files every version as it arrives — and
        // on Android, where the notification service files them while the app
        // is dead — so it can hold one the relays we just asked have not
        // caught up to. Merging over the older of the two would republish it
        // as newest.
        const stored = await readSettingsDoc(store, user.signer, user.pubkey, name);
        const dTag = settingsDTag(name);
        const fromRelays = events
          .filter((event) =>
            event.kind === SETTINGS_KIND
            && event.tags.some(([tag, value]) => tag === "d" && value === dTag))
          .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];

        // We know the user has this document, and this read didn't find it:
        // every relay we asked failed or is behind. Publishing a base we can't
        // confirm would drop whatever it is missing, on every device. Skipping
        // one document doesn't compromise the others — they're separate
        // coordinates — so the rest of the setup still gets published.
        if (!fromRelays && stored) {
          unrefreshed.push(name);
          continue;
        }

        const configKeys = name in CONFIG_KEYS_BY_DOC ? (name as ConfigDocName) : undefined;
        // Nothing local to merge in (read-state, reactions): mirror the newest
        // signed copy byte-for-byte, exactly as the list events above are
        // mirrored. Re-signing identical plaintext would only churn the
        // coordinate.
        if (!configKeys) {
          if (fromRelays) toPublish.push(fromRelays as NostrEvent);
          continue;
        }

        let previous: NostrRumor | undefined = fromRelays;
        let base: Record<string, unknown> = {};
        if (stored && (!fromRelays || stored.event.created_at >= fromRelays.created_at)) {
          previous = stored.event;
          base = stored.doc as Record<string, unknown>;
        } else if (fromRelays) {
          const decoded = await decodeSettingsDoc(fromRelays, user.signer, user.pubkey, name);
          if (!decoded) {
            throw new Error(
              `Could not decrypt your existing private settings (${name}); nothing was published`,
            );
          }
          base = decoded.doc as Record<string, unknown>;
        }

        const next = nextSettingsDoc(name, base as never, configSnapshot(config, configKeys) as never);
        const settingsEvent = await user.signer.signEvent({
          kind: SETTINGS_KIND,
          content: await user.signer.nip44.encrypt(user.pubkey, JSON.stringify(next)),
          tags: previous
            ? previous.tags.filter(([tag]) => tag !== "client")
            : [["d", dTag], ["title", `${APP_NAME} Settings`]],
          created_at: nextCreatedAt(previous),
        });
        toPublish.push(settingsEvent);
        settingsSeeds.push({ name, event: settingsEvent, doc: next });
      }

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
      // Into the store like every other version of these documents, so the
      // next read — here or in the notification service — sees what we
      // published.
      for (const { name, event, doc } of settingsSeeds) {
        await store.event(event);
        queryClient.setQueryData(settingsDocQueryKey(name, user.pubkey), { event, doc });
      }

      return {
        records: toPublish.length,
        destinations: targets.length,
        rejectedDeliveries,
        unrefreshed,
      };
    } finally {
      setIsPending(false);
    }
  }, [config, eventStore, nostr, queryClient, updateConfig, user]);

  return {
    publish,
    isPending,
    isConfigured,
    isAutomatic,
    isStatusLoading: metadataDoc.isLoading,
  };
}
