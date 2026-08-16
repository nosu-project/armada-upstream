import { useNostr } from "@nostrify/react";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";

import { APP_NAME } from "@/lib/platform";
import { PublishQueuedError, isPublishQueuedError, queueSignedEvent, removeQueuedPublish } from "@/lib/publishOutbox";
import { publishTimeoutMs } from "@/lib/publishTimeout";
import { markOwnWebPushEvent } from "@/lib/webPushState";
import { useCurrentUser } from "./useCurrentUser";
import { useEventStore } from "./useEventStore";

import type { NostrEvent } from "@nostrify/nostrify";

import type { NostrRumor } from "@/lib/nostrRumor";

/** Event template accepted by `useNostrPublish`. */
export type EventTemplate = Omit<NostrEvent, "id" | "pubkey" | "sig" | "created_at"> & {
  created_at?: number;
  /**
   * The previous version of the event being replaced (for replaceable/addressable kinds).
   * When provided, `published_at` from the old event is preserved on the new one.
   */
  prev?: NostrRumor;
  /**
   * When set, publish only to this relay (NIP-29 group traffic must stay on
   * the group's host server). When omitted, the event goes to all configured
   * servers via the pool's eventRouter.
   */
  relay?: string;
  /**
   * Publish to this exact relay set. Used for the user's portable self-state so
   * NIP-65 write relays keep receiving it even when they are disabled for
   * general pool traffic. Mutually exclusive with `relay`.
   */
  relays?: string[];
  /**
   * Called with the fully-signed event immediately before it is sent to the
   * network. Lets callers optimistically insert the event into a local cache
   * (and learn its final id) before the relay round-trip completes.
   */
  onSigned?: (event: NostrEvent) => void;
};

/** Returns true if the kind falls in a replaceable or addressable range. */
function isReplaceableKind(kind: number): boolean {
  if (kind === 0 || kind === 3) return true;
  return (kind >= 10000 && kind < 20000) || (kind >= 30000 && kind < 40000);
}

export function useNostrPublish(): UseMutationResult<NostrEvent, Error, EventTemplate> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const eventStore = useEventStore();

  return useMutation({
    mutationFn: async (t: EventTemplate) => {
      if (!user) {
        throw new Error("User is not logged in");
      }

      const { prev, relay, relays, onSigned, ...template } = t;
      if (relay && relays) throw new Error("Specify either relay or relays, not both");
      // NIP-89 client tag: always stamp this build. Replaceable RMW (mute list,
      // etc.) often copies prior public tags wholesale, including another app's
      // `client` — "add if missing" would then misattribute the new version.
      const tags = [
        ...(template.tags ?? []).filter(([name]) => name !== "client"),
        ["client", APP_NAME],
      ];

      const created_at = template.created_at ?? Math.floor(Date.now() / 1000);

      // published_at for replaceable/addressable events (NIP-24)
      if (isReplaceableKind(template.kind) && !tags.some(([name]) => name === "published_at")) {
        const oldTag = prev?.tags.find(([name]) => name === "published_at");
        if (oldTag) {
          tags.push(["published_at", oldTag[1]]);
        } else if (!prev) {
          tags.push(["published_at", String(created_at)]);
        }
      }

      const event = await user.signer.signEvent({
        kind: template.kind,
        content: template.content ?? "",
        tags,
        created_at,
      });

      if (event.pubkey !== user.pubkey) {
        throw new Error(
          "Signed event pubkey does not match the currently selected account. Please check your signer configuration.",
        );
      }

      // The relay's content-blind push gateway may echo this event back before
      // the page sees it through the normal ingest path. Record it first so the
      // service worker can identify the resulting push as locally authored.
      await markOwnWebPushEvent(event.id);

      // Store the signed event locally before any network work. This makes
      // offline-created profiles/settings visible immediately and gives the
      // retry worker a durable copy if the app closes before relays recover.
      //
      // Filed under the relay it is being published TO, which for a NIP-29 send
      // is the only relay the message exists on — the same tenant the timeline
      // reads back. (The durable copy for RETRY is the publish outbox below, not
      // this one: the store drops `sig`.)
      void eventStore.then((store) => store.event(event, { relay })).catch(() => undefined);
      // Awaited, unlike the store write: the queue and the `removeQueuedPublish`
      // below are both async now, and a fire-and-forget queue could land AFTER
      // the removal that a successful publish issues — leaving a delivered
      // event queued forever.
      //
      // Awaited but not FATAL. The queue is the retry-after-restart safety net,
      // and KV can genuinely fail (quota, an unavailable IndexedDB under iOS
      // Lockdown Mode). Letting that throw here would abort a publish that was
      // about to succeed — losing the send outright to protect its backup, and
      // without even rendering it optimistically, since `onSigned` is below.
      await queueSignedEvent(event, relay).catch(() => undefined);

      // Let callers optimistically render the event before the network call.
      onSigned?.(event);

      try {
        // Budget scaled to the signer: an auth-gating relay can demand a
        // NIP-42 sign inside this await, which costs a full bunker round-trip
        // for NIP-46 logins (#51).
        const timeout = publishTimeoutMs(user.method);
        if (relay) {
          await nostr.relay(relay).event(event, { signal: AbortSignal.timeout(timeout) });
        } else if (relays && relays.length > 0) {
          await nostr.group(relays).event(event, { signal: AbortSignal.timeout(timeout) });
        } else {
          await nostr.event(event, { signal: AbortSignal.timeout(timeout) });
        }
      } catch (error) {
        throw new PublishQueuedError(event, error);
      }

      // Outside the try: the relay has accepted the event by now, so a failure
      // to clear its queue entry must not be reported as a queued publish. The
      // worst case is one redundant re-delivery, which relays dedup by id.
      await removeQueuedPublish(event.id).catch(() => undefined);

      return event;
    },
    onError: (error) => {
      if (isPublishQueuedError(error)) return;
      console.error("Failed to publish event:", error);
    },
  });
}

/**
 * Re-publish an already-signed event (e.g. retrying a failed optimistic send).
 * Unlike `useNostrPublish`, this does not re-sign or mutate tags — the event id
 * is preserved so it reconciles with the original optimistic message.
 */
export function useRepublish(): UseMutationResult<
  NostrEvent,
  Error,
  { event: NostrEvent; relay?: string }
> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();

  return useMutation({
    mutationFn: async ({ event, relay }) => {
      // The local event store drops signatures, so an event read back from it
      // carries `sig: ""` and every relay will reject it. Fail here instead: a
      // silent rejection looks identical to a network failure, and the retry
      // that produced it would loop forever against a relay that is fine.
      if (!event.sig) {
        throw new Error("Cannot re-publish an unsigned event (its signature was not preserved).");
      }
      await markOwnWebPushEvent(event.id);
      const timeout = publishTimeoutMs(user?.method);
      if (relay) {
        await nostr.relay(relay).event(event, { signal: AbortSignal.timeout(timeout) });
      } else {
        await nostr.event(event, { signal: AbortSignal.timeout(timeout) });
      }
      return event;
    },
  });
}
