import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import type { NostrFilter, NostrSigner } from "@nostrify/nostrify";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { APP_NAME } from "@/lib/platform";
import { newestOf, readToEose } from "@/lib/relayRead";
import { EncryptedSettingsSchema, type EncryptedSettings } from "@/lib/schemas";
import type { NostrRumor } from "@/lib/nostrRumor";

/** NIP-78 application-data kind. */
const SETTINGS_KIND = 30078;
/** `d` tag identifying Armada's settings event. */
const SETTINGS_D = "armada/metadata";

/** How long the relay read may take before we fall back to the local mirror. */
const SETTINGS_READ_TIMEOUT_MS = 6000;
/** How long a CONFIRMED read stays fresh. */
const SETTINGS_STALE_MS = 60_000;
/**
 * How often to re-attempt a read that never completed. Bounded and
 * self-cancelling: it stops the moment one read finishes (`complete`), and
 * React Query does not run intervals while the app is unfocused, so a
 * backgrounded client doesn't poll.
 */
const SETTINGS_RETRY_MS = 20_000;

/** Filter matching the current user's settings event. */
function settingsFilter(pubkey: string): NostrFilter {
  return { kinds: [SETTINGS_KIND], authors: [pubkey], "#d": [SETTINGS_D], limit: 1 };
}

/** Where the settings we're holding actually came from. */
export type SettingsSource =
  /** Read from a relay this fetch. The only value that proves a good base. */
  | "remote"
  /** No relay event; this is the locally-mirrored copy, possibly stale. */
  | "local"
  /** Nothing anywhere, or an event we could not decrypt. */
  | "none";

export interface SettingsRead {
  settings: EncryptedSettings | null;
  source: SettingsSource;
  /**
   * True when the read was authoritative — every routed relay answered, or we
   * got an event. False means we simply failed to ask, and an empty result
   * must not be treated as "the user has no settings".
   */
  complete: boolean;
}

/** Decrypt + validate a settings event into EncryptedSettings, or null. */
async function decodeSettings(
  signer: NostrSigner,
  pubkey: string,
  event: NostrRumor | undefined,
): Promise<EncryptedSettings | null> {
  if (!event?.content || !signer.nip44) return null;
  try {
    const decrypted = await signer.nip44.decrypt(pubkey, event.content);
    const parsed = EncryptedSettingsSchema.safeParse(JSON.parse(decrypted));
    return parsed.success ? parsed.data : null;
  } catch (err) {
    console.warn("Failed to decrypt settings:", err);
    return null;
  }
}

/**
 * ms timestamp of the last local encrypted-settings write this session. Lets
 * NostrSync avoid overwriting a fresh local edit with a stale relay event.
 */
let lastWriteTs = 0;
export function getLastSettingsWrite(): number {
  return lastWriteTs;
}
/**
 * Mark "now" as a local edit time. Called the moment a synced-config edit is
 * detected — BEFORE the debounced publish actually runs — so NostrSync's
 * `remoteTs > localTs` guard protects the fresh edit during the debounce window
 * (otherwise a stale relay copy landing in that window can revert it).
 */
export function setLastSettingsWrite(ts: number = Date.now()): void {
  lastWriteTs = ts;
}

/** Persist the synced timestamp per-pubkey so reloads can trust localStorage. */
export function getLocalSettingsSync(pubkey: string): number {
  try {
    return Number(localStorage.getItem(`armada:settings-lastSync:${pubkey}`)) || 0;
  } catch {
    return 0;
  }
}
export function setLocalSettingsSync(pubkey: string, lastSync: number): void {
  try {
    localStorage.setItem(`armada:settings-lastSync:${pubkey}`, String(lastSync));
  } catch {
    // localStorage unavailable — ignore.
  }
}

/**
 * Read and write the user's encrypted app settings (theme + customTheme +
 * themes) as a NIP-44-encrypted kind 30078 event on the app relays. Adapted
 * from Ditto's useEncryptedSettings.
 */
export function useEncryptedSettings() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const pendingSettings = useRef<EncryptedSettings | null>(null);

  const queryKey = ["encrypted-settings", user?.pubkey];

  const settings = useQuery<SettingsRead>({
    queryKey,
    enabled: !!user?.pubkey && !!user.signer.nip44,
    queryFn: async ({ signal }): Promise<SettingsRead> => {
      if (!user?.signer.nip44) return { settings: null, source: "none", complete: false };

      // `readToEose`, not `nostr.query`: the pool's 300ms eoseTimeout makes
      // `query` give up as soon as the FIRST relay answers, so on a cold or
      // just-resumed client the relay holding this event routinely never gets
      // asked. See lib/relayRead.ts — this is the read that decides whether
      // another device's config reaches this one.
      const { events, complete } = await readToEose(nostr, [settingsFilter(user.pubkey)], {
        signal,
        timeoutMs: SETTINGS_READ_TIMEOUT_MS,
      });
      const event = newestOf(events);

      if (event) {
        // Mirror into the local store (fire-and-forget) for offline reads.
        void eventStore.then((store) => store.event(event)).catch(() => undefined);
        const decoded = await decodeSettings(user.signer, user.pubkey, event);
        // A decrypt failure is authoritative in the sense that matters: we
        // found the event and still have no usable base, so retrying on a
        // timer would just fail identically. `source` stays "none" so nothing
        // publishes a merge over settings we could not read.
        if (!decoded) return { settings: null, source: "none", complete: true };
        return { settings: decoded, source: "remote", complete: true };
      }

      // No relay event. Fall back to the locally mirrored copy so the
      // last-known config still applies to the UI — but report it as such.
      // `complete` distinguishes the two very different reasons we got here:
      // every relay answered and none had it (a genuine first load), versus we
      // never managed to ask (offline, slow, still authenticating). Callers
      // that would WRITE based on this must only trust `source === "remote"`;
      // an empty read that is really a failed read is how a replaceable-event
      // wipe happens.
      const store = await eventStore;
      const cached = await store.query([settingsFilter(user.pubkey)]);
      const decoded = await decodeSettings(user.signer, user.pubkey, newestOf(cached));
      return { settings: decoded, source: decoded ? "local" : "none", complete };
    },
    // Only a confirmed read earns the full freshness window. A fallback read is
    // stale immediately, so the next focus/mount re-reads instead of serving a
    // possibly-stale local copy for a minute and calling it fresh.
    staleTime: (query) => (query.state.data?.source === "remote" ? SETTINGS_STALE_MS : 0),
    // And actively re-attempt an incomplete read, so a client whose radio came
    // back twenty seconds after launch catches up on its own. Stops as soon as
    // any read completes.
    refetchInterval: (query) => (query.state.data?.complete ? false : SETTINGS_RETRY_MS),
    // Cross-device freshness is driven by NostrSync's standing self-state REQ,
    // which invalidates this query when another device publishes new settings.
    // Focus/mount refetch is the backstop for everything the sub missed while
    // the socket was down.
    refetchOnWindowFocus: true,
    refetchOnMount: true,
  });

  const updateSettings = useMutation({
    mutationFn: async (patch: Partial<EncryptedSettings>) => {
      if (!user?.signer.nip44) throw new Error("NIP-44 encryption not supported by signer");

      // Merge over the freshest known state (cache + this session's pending).
      const base: EncryptedSettings = {
        ...(settings.data?.settings ?? {}),
        ...(pendingSettings.current ?? {}),
      };
      const next: EncryptedSettings = { ...base, ...patch, lastSync: Date.now() };
      pendingSettings.current = next;
      lastWriteTs = Date.now();

      const plaintext = JSON.stringify(next);
      const content = await user.signer.nip44.encrypt(user.pubkey, plaintext);

      const event = await user.signer.signEvent({
        kind: SETTINGS_KIND,
        content,
        tags: [
          ["d", SETTINGS_D],
          ["title", `${APP_NAME} Settings`],
        ],
        created_at: Math.floor(Date.now() / 1000),
      });

      // Optimistically update the cache, then publish in the background.
      // Recorded as a confirmed read: we just built this blob over a base we
      // had, and it is now the newest state we know of, so subsequent merges
      // may safely build on it.
      queryClient.setQueryData<SettingsRead>(queryKey, {
        settings: next,
        source: "remote",
        complete: true,
      });
      setLocalSettingsSync(user.pubkey, next.lastSync ?? Date.now());
      // Persist locally first (offline durability), then publish.
      void eventStore.then((store) => store.event(event)).catch(() => undefined);
      nostr.event(event, { signal: AbortSignal.timeout(8000) }).catch((err) => {
        console.warn("Failed to publish encrypted settings:", err);
      });

      return next;
    },
  });

  return {
    settings: settings.data?.settings ?? null,
    /**
     * Where {@link settings} came from. `"remote"` is the ONLY value that
     * proves we read the user's real event this session — the others mean we
     * are showing a local mirror (or nothing) and must not write over the
     * remote on that basis.
     */
    settingsSource: settings.data?.source ?? "none",
    isLoading: settings.isLoading,
    /** True once the query has resolved at least once (event or cache miss). */
    isFetched: settings.isFetched,
    /**
     * True once the settings query has completed a successful pull (the query
     * never rejects — relay errors are swallowed — so in practice this tracks
     * "the first fetch has resolved"). NostrSync waits for this before acting,
     * but does NOT treat it as proof the remote was read; see its publish gate,
     * which keys off `settingsSource` instead.
     */
    isSuccess: settings.isSuccess,
    refetch: settings.refetch,
    updateSettings: updateSettings.mutateAsync,
    hasNip44Support: !!user?.signer.nip44,
  };
}
