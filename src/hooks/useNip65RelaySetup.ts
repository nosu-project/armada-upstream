import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { selfStateRelays } from "@/contexts/AppContext";
import { mirrorPortableStateBeforeRelayChange } from "@/hooks/usePublishPortableSetup";
import {
  buildRelayListTags,
  discoverRelayList,
  discoverRelayListWithStatus,
  KIND_RELAY_LIST,
  newestRelayList,
  publishRelayListEvent,
  queryExplicitRelaysWithStatus,
  relayListIsNewerThanMetadata,
  type RelayListDiscovery,
  type RelayListPublishResult,
  type RelayPreference,
  uniqueRelayUrls,
} from "@/lib/nip65";
import { RELAY_LIST_DISCOVERY_RELAYS } from "@/lib/platform";
import { publishTimeoutMs } from "@/lib/publishTimeout";
import { queueSignedEvent, recordQueuedPublishAttempt } from "@/lib/publishOutbox";
import { SELF_SYNC_OWNER_QUERY_KEYS } from "@/lib/selfSyncKinds";
import { KIND_USER_GROUPS } from "@/lib/nip29";
import { SETTINGS_KIND } from "@/lib/settingsDocs";
import { KIND_INVITE_LIST } from "@/concord/lib/kinds";

import type { RelayMetadata } from "@/contexts/AppContext";
import type { NostrEvent } from "@nostrify/nostrify";

/** Whether phase-one preseed observed a pointer newer than its local baseline. */
export function relayPointerChangedDuringPreseed(
  metadata: RelayMetadata,
  pubkey: string,
  candidate: Pick<NostrEvent, "created_at" | "id"> | undefined,
): boolean {
  if (!candidate) return false;
  if (metadata.pubkey !== pubkey) return true;
  return candidate.created_at > metadata.updatedAt
    || (
      candidate.created_at === metadata.updatedAt
      && metadata.eventId !== undefined
      && candidate.id !== metadata.eventId
      && candidate.id < metadata.eventId
    );
}

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
  const eventStore = useEventStore();

  const discoveryRelays = useMemo(
    () => uniqueRelayUrls([...config.appRelays, ...RELAY_LIST_DISCOVERY_RELAYS]),
    [config.appRelays],
  );

  const adopt = useCallback((discovery: RelayListDiscovery) => {
    updateConfig((current) => {
      const sameOwner = current.relayMetadata.pubkey === user?.pubkey;
      if (sameOwner && !relayListIsNewerThanMetadata(
        discovery.event,
        current.relayMetadata,
      )) return current;
      return {
        ...current,
        useUserRelays: true,
        relayMetadata: {
          relays: discovery.relays,
          updatedAt: discovery.event.created_at,
          eventId: discovery.event.id,
          pubkey: user?.pubkey,
        },
      };
    });
    // The general pool changes on the next render. Invalidate the self-owned
    // caches then; their refetches and NostrSync's restarted standing REQ will
    // ask the newly-adopted relays.
    setTimeout(() => {
      for (const queryKey of SELF_SYNC_OWNER_QUERY_KEYS) {
        queryClient.invalidateQueries({ queryKey: [...queryKey] });
      }
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

    const declared = tags.map((tag) => tag[1]).filter((url): url is string => Boolean(url));
    const proposedWrites = tags
      .filter((tag) => tag[2] !== "read")
      .map((tag) => tag[1])
      .filter((url): url is string => Boolean(url));
    if (proposedWrites.length === 0) {
      throw new Error("Keep at least one write relay for portable account state");
    }
    const oldSelfRelays = selfStateRelays(config, user.pubkey);
    const targets = uniqueRelayUrls([
      ...declared,
      ...oldSelfRelays,
      ...config.appRelays,
      ...RELAY_LIST_DISCOVERY_RELAYS,
    ]);
    const timeout = publishTimeoutMs(user.method);

    // Two-phase relay rotation: the old/source set remains authoritative until
    // every proposed write relay has accepted the exact signed portable
    // records. Only then publish the 10002 pointer that makes the new set live.
    const sourceRelays = uniqueRelayUrls([
      ...oldSelfRelays,
      ...config.appRelays,
      ...RELAY_LIST_DISCOVERY_RELAYS,
    ]);
    const oldDeclaredWrites = uniqueRelayUrls(
      config.relayMetadata.pubkey === user.pubkey
        ? config.relayMetadata.relays
          .filter((relay) => relay.write)
          .map((relay) => relay.url)
        : [],
    );
    const store = await eventStore;
    const loadLocalPortableState = async () => {
      try {
        return await store.query([{
          kinds: [
            KIND_RELAY_LIST,
            10007,
            KIND_USER_GROUPS,
            10050,
            10063,
            KIND_INVITE_LIST,
            SETTINGS_KIND,
            33302,
          ],
          authors: [user.pubkey],
        }]);
      } catch {
        // Wire-only preseed remains possible when the local store is unavailable.
        return [];
      }
    };
    let localSingletons = await loadLocalPortableState();
    let mirrored = await mirrorPortableStateBeforeRelayChange(
      nostr,
      user,
      sourceRelays,
      proposedWrites,
      oldDeclaredWrites.length > 0 ? oldDeclaredWrites : sourceRelays,
      oldDeclaredWrites.length > 0,
      localSingletons,
    );

    // Phase one can take several signer/relay round-trips. Re-read both the
    // pointer and every portable coordinate until two consecutive snapshots
    // agree. This is the bounded optimistic-transaction available on Nostr:
    // a sibling write that lands during phase one is re-mirrored, never left
    // only on a relay the new pointer is about to remove.
    const pointerRefreshRelays = uniqueRelayUrls([...sourceRelays, ...proposedWrites]);
    const ownsPointer = config.relayMetadata.pubkey === user.pubkey;
    const refreshPointer = async () => {
      const read = await discoverRelayListWithStatus(
        nostr,
        user.pubkey,
        pointerRefreshRelays,
        AbortSignal.timeout(8_000),
      );
      const discovery = read.discovery;
      const answered = new Set(read.answered);
      const sourceComplete = oldDeclaredWrites.length > 0
        ? oldDeclaredWrites.every((url) => answered.has(url))
        : sourceRelays.some((url) => answered.has(url));
      const complete = sourceComplete
        && proposedWrites.every((url) => answered.has(url));
      if (!complete || (ownsPointer && !discovery)) {
        throw new Error("Could not refresh the current NIP-65 relay list after copying setup; retry without changing relays");
      }
      if (ownsPointer && discovery) {
        const baselineId = config.relayMetadata.eventId;
        const isKnownBaseline = baselineId !== undefined
          ? discovery.event.id === baselineId
          : discovery.event.created_at === config.relayMetadata.updatedAt;
        if (!isKnownBaseline && !relayPointerChangedDuringPreseed(
          config.relayMetadata,
          user.pubkey,
          discovery.event,
        )) {
          throw new Error("Could not confirm the current NIP-65 relay-list version; retry without changing relays");
        }
      }
      if (relayPointerChangedDuringPreseed(
        config.relayMetadata,
        user.pubkey,
        discovery?.event,
      )) {
        throw new Error("Your NIP-65 relay list changed on another device; review it and retry");
      }
      return discovery;
    };

    await refreshPointer();
    let refreshed: RelayListDiscovery | undefined;
    let portableStable = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      localSingletons = await loadLocalPortableState();
      const next = await mirrorPortableStateBeforeRelayChange(
        nostr,
        user,
        sourceRelays,
        proposedWrites,
        oldDeclaredWrites.length > 0 ? oldDeclaredWrites : sourceRelays,
        oldDeclaredWrites.length > 0,
        localSingletons,
      );
      refreshed = await refreshPointer();
      if (next.fingerprint === mirrored.fingerprint) {
        portableStable = true;
        break;
      }
      mirrored = next;
    }
    if (!portableStable) {
      throw new Error("Portable account state kept changing during relay migration; retry after the other device finishes syncing");
    }
    const createdAt = Math.max(
      Math.floor(Date.now() / 1000),
      ownsPointer ? config.relayMetadata.updatedAt + 1 : 0,
      (refreshed?.event.created_at ?? 0) + 1,
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
    // Refuse the pointer fan-out if its exact bytes and destinations could not
    // first be made durable. Partial delivery without that retry record can
    // strand old devices on the previous relay set.
    await queueSignedEvent(event, undefined, targets, { inheritPendingTargets: false });
    const result = await publishRelayListEvent(nostr, event, targets, timeout);
    await recordQueuedPublishAttempt(event.id, targets, result.rejected).catch(() => undefined);
    if (result.accepted.length === 0) {
      throw new Error("No relay accepted your signed relay list");
    }
    const rejected = new Set(result.rejected);
    // Only the write relays named by the previous authoritative pointer are
    // the compatibility bridge for an old device. App/discovery relays remain
    // best-effort (and durably queued above): treating one dead public index as
    // authoritative would make an otherwise safe relay rotation impossible.
    if (oldDeclaredWrites.some((url) => rejected.has(url))) {
      throw new Error("An existing account-state relay missed the new relay list; retry before switching");
    }

    // ACK means only that a relay received these bytes, not that they remain
    // the NIP-01 winner. A sibling can publish between the pre-sign refresh and
    // this fan-out. Re-read every old/new authoritative write relay and adopt
    // only if our exact event is still the aggregate winner.
    const confirmed = await discoverRelayListWithStatus(
      nostr,
      user.pubkey,
      targets,
      AbortSignal.timeout(8_000),
    );
    const answeredAfterPublish = new Set(confirmed.answered);
    const authoritativeTargets = uniqueRelayUrls([
      ...oldDeclaredWrites,
      ...proposedWrites,
    ]);
    if (!authoritativeTargets.every((url) => answeredAfterPublish.has(url))) {
      throw new Error("Could not confirm the new NIP-65 relay list on every account-state relay; it remains queued for retry");
    }
    if (confirmed.discovery?.event.id !== event.id) {
      throw new Error("A newer NIP-65 relay list won while this change was publishing; local relay settings were not switched");
    }
    const perRelay = await Promise.all(authoritativeTargets.map(async (url) => ({
      url,
      read: await queryExplicitRelaysWithStatus(
        nostr,
        [url],
        [{ kinds: [KIND_RELAY_LIST], authors: [user.pubkey], limit: 1 }],
        AbortSignal.timeout(8_000),
      ),
    })));
    for (const { url, read } of perRelay) {
      const winner = newestRelayList(
        read.events.filter((candidate) => candidate.pubkey === user.pubkey),
      );
      if (!read.answered.includes(url) || winner?.id !== event.id) {
        throw new Error(
          `Account-state relay ${url} did not retain the new NIP-65 winner; local relay settings were not switched`,
        );
      }
    }

    adopt({ event, relays: tags.map((tag) => ({
      url: tag[1]!,
      read: tag[2] !== "write",
      write: tag[2] !== "read",
    })) });
    return result;
  }, [adopt, config, eventStore, nostr, user]);

  return {
    discoveryRelays,
    discover,
    adopt,
    publish,
  };
}
