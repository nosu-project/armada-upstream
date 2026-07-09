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
 * (e.g. Armada's own relay) simply ignore — or reject — the unknown ephemeral
 * kind. Either way the relay-join is a *speculative, best-effort* step: it can
 * help a relay that gates on relay membership, but its failure must never block
 * the NIP-29 group join (the group join is the source of truth — if relay
 * membership actually matters, the group join itself reports "restricted: you
 * are not a member of this relay", which the caller handles). So this never
 * throws.
 */

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
 * ephemeral KIND_RELAY_JOIN with the supplied claim.
 *
 * This is a speculative, best-effort handshake (see the file header): it helps
 * relays that gate on relay-level membership, and no-ops on every other relay.
 * It NEVER throws — a relay that doesn't implement the scheme will reject the
 * unknown ephemeral kind (e.g. relay29 rejects it for lacking an `h` tag), and
 * that rejection is meaningless here. Whether relay membership actually matters
 * is decided by the subsequent NIP-29 group join, not by this pre-step.
 */
export function useJoinRelay() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();

  return useMutation({
    mutationFn: async ({ relayUrl, claim }: { relayUrl: string; claim?: string }) => {
      if (!user) return;

      const tags: string[][] = [];
      if (claim) tags.push(["claim", claim]);

      try {
        const event = await user.signer.signEvent({
          kind: KIND_RELAY_JOIN,
          content: "",
          tags,
          created_at: Math.floor(Date.now() / 1000),
        });
        await nostr.relay(relayUrl).event(event, { signal: AbortSignal.timeout(8000) });
      } catch {
        // Best-effort: any failure (unsupported kind, timeout, h-tag policy,
        // bad claim) is non-fatal here. The group join reports the real outcome.
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
