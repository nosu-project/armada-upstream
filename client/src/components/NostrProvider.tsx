import React, { useEffect, useMemo, useRef } from "react";
import { NostrEvent, NostrFilter, NPool, NRelay1 } from "@nostrify/nostrify";
import { NostrContext } from "@nostrify/react";
import { NUser, useNostrLogin } from "@nostrify/react/login";
import type { NostrSigner } from "@nostrify/types";

import { NIndexedDB } from "@nostrify/indexeddb";

import { EventStoreContext } from "@/contexts/EventStoreContext";
import { useAppContext } from "@/hooks/useAppContext";
import { NostrBatcher } from "@/lib/NostrBatcher";
import { normalizeRelayUrl, PLATFORM_RELAYS } from "@/lib/platform";

interface NostrProviderProps {
  children: React.ReactNode;
}

/**
 * Provides the relay pool for the whole app.
 *
 * Ported from Ditto's NostrProvider:
 * - NIP-42 AUTH: every relay opened through the pool (including targeted
 *   `nostr.relay(url)` handles) signs kind 22242 challenges with the active
 *   login's signer.
 * - Queries are batched (NostrBatcher) and cached in IndexedDB.
 *
 * Routing is Armada-specific: generic pool traffic (kind 0 profiles, kind
 * 10009 lists, anything not group-scoped) goes to the configurable app
 * relays (Ditto-style, default relay.ditto.pub + relay.dreamith.to) plus all
 * configured servers. Group-scoped traffic should use
 * `nostr.relay(serverUrl)` directly so it stays on that server.
 */
const NostrProvider: React.FC<NostrProviderProps> = (props) => {
  const { children } = props;
  const { config } = useAppContext();
  const { logins } = useNostrLogin();

  const pool = useRef<NPool | undefined>(undefined);

  // Shared IndexedDB event cache (batcher writes results into it). Backed by
  // @nostrify/indexeddb (the strfry-port NStore). Its constructor is synchronous
  // — it opens the DB in the background and every method awaits the connection —
  // but the EventStoreContext contract is a Promise, so wrap it. Use a fresh DB
  // name ("armada-events") rather than the legacy "ditto-events": the package
  // installs schema version 1, and pointing it at the old v2 database would make
  // IndexedDB reject the open as a downgrade (→ silent no-op cache).
  const eventStore = useRef<Promise<NIndexedDB> | undefined>(undefined);
  eventStore.current ??= Promise.resolve(new NIndexedDB("armada-events"));

  // Pool routes: app relays (non-NIP-29 traffic) + all servers
  // (platform-pinned + user-added). The internal servers stay in the set so
  // a fully air-gapped deployment keeps working with zero app relays.
  const poolRelays = useMemo(() => {
    const urls = new Set<string>();
    for (const url of config.appRelays) {
      const normalized = normalizeRelayUrl(url);
      if (normalized) urls.add(normalized);
    }
    for (const url of PLATFORM_RELAYS) urls.add(url);
    for (const url of config.addedRelays) {
      const normalized = normalizeRelayUrl(url);
      if (normalized) urls.add(normalized);
    }
    return [...urls];
  }, [config.appRelays, config.addedRelays]);

  const poolRelaysRef = useRef(poolRelays);
  useEffect(() => {
    poolRelaysRef.current = poolRelays;
  }, [poolRelays]);

  // Search relays (NIP-50). `search` filters route here instead of fanning
  // out to every server. Falls back to the pool relays when none configured.
  const searchRelays = useMemo(() => {
    const urls = new Set<string>();
    for (const url of config.searchRelays) {
      const normalized = normalizeRelayUrl(url);
      if (normalized) urls.add(normalized);
    }
    return [...urls];
  }, [config.searchRelays]);

  const searchRelaysRef = useRef(searchRelays);
  useEffect(() => {
    searchRelaysRef.current = searchRelays;
  }, [searchRelays]);

  // Stable ref to the current user's signer for NIP-42 AUTH. The `open()`
  // callback reads from this ref when a relay sends an AUTH challenge, so it
  // always uses the latest signer without recreating the pool.
  const signerRef = useRef<NostrSigner | undefined>(undefined);

  const currentLogin = logins[0];
  const currentSigner = useMemo(() => {
    if (!currentLogin) return undefined;
    try {
      switch (currentLogin.type) {
        case "nsec":
          return NUser.fromNsecLogin(currentLogin).signer;
        case "bunker":
          // pool.current is created synchronously during first render below.
          return NUser.fromBunkerLogin(currentLogin, pool.current!).signer;
        case "extension":
          return NUser.fromExtensionLogin(currentLogin).signer;
        default:
          return undefined;
      }
    } catch {
      return undefined;
    }
  }, [currentLogin]);

  signerRef.current = currentSigner;

  if (!pool.current) {
    pool.current = new NPool({
      open(url: string) {
        return new NRelay1(url, {
          // NIP-42: respond to relay AUTH challenges by signing a kind 22242
          // ephemeral event with the current user's signer.
          auth: async (challenge: string) => {
            const signer = signerRef.current;
            if (!signer) {
              throw new Error("AUTH failed: no signer available (user not logged in)");
            }
            return signer.signEvent({
              kind: 22242,
              content: "",
              tags: [
                ["relay", url],
                ["challenge", challenge],
              ],
              created_at: Math.floor(Date.now() / 1000),
            });
          },
        });
      },
      reqRouter(filters: NostrFilter[]): Map<string, NostrFilter[]> {
        // NIP-50 search: route to dedicated search relays (Ditto pattern),
        // falling back to the pool relays when none are configured.
        if (filters.some((f) => "search" in f)) {
          const targets = searchRelaysRef.current.length > 0
            ? searchRelaysRef.current
            : poolRelaysRef.current;
          return new Map(targets.map((url) => [url, filters]));
        }
        return new Map(poolRelaysRef.current.map((url) => [url, filters]));
      },
      eventRouter(_event: NostrEvent) {
        return [...poolRelaysRef.current];
      },
      // Resolve queries quickly once any relay sends EOSE.
      eoseTimeout: 300,
    });
  }

  // Wrap the pool in the batching proxy (combines profile/id lookups into single REQs).
  const batcher = useRef<NostrBatcher | undefined>(undefined);
  if (!batcher.current && pool.current) {
    batcher.current = new NostrBatcher(pool.current, eventStore.current);
  }

  useEffect(() => {
    return () => {
      pool.current?.close();
    };
  }, []);

  return (
    <NostrContext.Provider value={{ nostr: (batcher.current ?? pool.current) as unknown as NPool }}>
      <EventStoreContext.Provider value={eventStore.current}>
        {children}
      </EventStoreContext.Provider>
    </NostrContext.Provider>
  );
};

export default NostrProvider;
