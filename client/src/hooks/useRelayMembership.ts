import { useNostr } from "@nostrify/react";
import { useMutation } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { KIND_RELAY_INVITE, KIND_RELAY_JOIN, KIND_RELAY_LEAVE } from "@/lib/nip29";

/**
 * Relay-level membership for community relays (zooid / Coracle, which back
 * Flotilla and Soapbox). These relays gate *all* reads and writes behind
 * membership of the relay itself — distinct from per-group NIP-29 membership —
 * and reject non-members with "restricted: you are not a member of this relay".
 *
 * To join such a relay a client publishes an ephemeral KIND_RELAY_JOIN (28934)
 * carrying a `claim` tag, whose value the relay minted as a KIND_RELAY_INVITE
 * (28935). See zooid `management.go` (`ValidateJoinRequest`) and Flotilla
 * `attemptRelayAccess` for the reference implementation.
 *
 * This is intentionally relay-agnostic: relays that don't implement the scheme
 * (e.g. Armada's own relay) simply ignore the unknown ephemeral kind, so it is
 * always safe to attempt before a NIP-29 group join.
 */

/** Relay responses that mean "the relay-join is effectively satisfied". */
function isBenignRelayJoinError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("duplicate") || // already a member
    m.includes("already") ||
    // Relays that don't implement relay-join may reject the unknown ephemeral
    // kind outright; that's fine — they don't gate on relay membership.
    m.includes("not accepted") ||
    m.includes("invalid: this event's kind")
  );
}

/**
 * Fetch a fresh invite claim from a relay. Relays that support the scheme issue
 * one kind 28935 per requesting (authed) pubkey when queried; members with
 * invite privileges get a reusable `claim` value. Returns undefined if the
 * relay doesn't issue one (it may not implement the scheme, or the user may
 * lack invite rights).
 */
export function useRelayClaim() {
  const { nostr } = useNostr();

  return useMutation({
    mutationFn: async (relayUrl: string): Promise<string | undefined> => {
      try {
        const events = await nostr.relay(relayUrl).query(
          [{ kinds: [KIND_RELAY_INVITE], limit: 1 }],
          { signal: AbortSignal.timeout(6000) },
        );
        const claim = events[0]?.tags.find(([n]) => n === "claim")?.[1];
        return claim || undefined;
      } catch {
        return undefined;
      }
    },
  });
}

/**
 * Ensure the current user is a member of the given relay by publishing an
 * ephemeral KIND_RELAY_JOIN with the supplied claim. No-ops gracefully on
 * relays that don't implement relay-level membership.
 *
 * Resolves on success (or benign "already a member"); rejects only when the
 * relay actively refuses the join with a non-benign reason (e.g. a bad/missing
 * claim on a closed relay).
 */
export function useJoinRelay() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();

  return useMutation({
    mutationFn: async ({ relayUrl, claim }: { relayUrl: string; claim?: string }) => {
      if (!user) throw new Error("User is not logged in");

      const tags: string[][] = [];
      if (claim) tags.push(["claim", claim]);

      const event = await user.signer.signEvent({
        kind: KIND_RELAY_JOIN,
        content: "",
        tags,
        created_at: Math.floor(Date.now() / 1000),
      });

      try {
        await nostr.relay(relayUrl).event(event, { signal: AbortSignal.timeout(8000) });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (isBenignRelayJoinError(message)) return;
        throw e;
      }
    },
  });
}

/** Publish an ephemeral relay-leave (best-effort; ignores unsupported relays). */
export function useLeaveRelay() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();

  return useMutation({
    mutationFn: async (relayUrl: string) => {
      if (!user) throw new Error("User is not logged in");
      const event = await user.signer.signEvent({
        kind: KIND_RELAY_LEAVE,
        content: "",
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      });
      try {
        await nostr.relay(relayUrl).event(event, { signal: AbortSignal.timeout(8000) });
      } catch {
        // best-effort
      }
    },
  });
}
