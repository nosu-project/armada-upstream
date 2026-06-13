import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { KIND_GROUP_PARTICIPANTS, parseGroupParticipants } from "@/lib/nip29";
import { relayToHttpUrl } from "@/lib/platform";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NostrSigner } from "@nostrify/types";

/** NIP-98 HTTP Auth event kind. */
const KIND_HTTP_AUTH = 27235;

interface LivekitTokenResponse {
  /** LiveKit access JWT. */
  token: string;
  /** LiveKit server websocket URL. */
  url: string;
}

/**
 * Check whether a relay supports the NIP-29 LiveKit extension
 * (HTTP 204 at /.well-known/nip29/livekit).
 */
export function useRelayLivekitSupport(relayUrl: string | undefined) {
  return useQuery({
    queryKey: ["nip29", "livekit-support", relayUrl],
    queryFn: async ({ signal }) => {
      try {
        const res = await fetch(`${relayToHttpUrl(relayUrl!)}/.well-known/nip29/livekit`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        });
        return res.status === 204 || res.ok;
      } catch {
        return false;
      }
    },
    enabled: Boolean(relayUrl),
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Fetch a LiveKit JWT from the relay's NIP-29 token endpoint using a
 * NIP-98 Authorization event signed by the user's signer.
 */
async function fetchLivekitToken(
  relayUrl: string,
  groupId: string,
  signer: NostrSigner,
): Promise<LivekitTokenResponse> {
  const endpointUrl = `${relayToHttpUrl(relayUrl)}/.well-known/nip29/livekit/${encodeURIComponent(groupId)}`;

  const event = await signer.signEvent({
    kind: KIND_HTTP_AUTH,
    content: "",
    tags: [
      ["u", endpointUrl],
      ["method", "GET"],
    ],
    created_at: Math.floor(Date.now() / 1000),
  });

  const res = await fetch(endpointUrl, {
    method: "GET",
    headers: {
      Authorization: `Nostr ${btoa(JSON.stringify(event))}`,
    },
  });

  if (!res.ok) {
    throw new Error(`LiveKit token request failed: HTTP ${res.status}`);
  }

  const data: Record<string, string> = await res.json();
  const token = data.participant_token ?? data.token;
  const url = data.server_url ?? data.url;
  if (!token || !url) {
    throw new Error("LiveKit token response missing token or url");
  }
  return { token, url };
}

/** Request a LiveKit token for a group's AV room (only when `enabled`). */
export function useLivekitToken(relayUrl: string, groupId: string, enabled: boolean) {
  const { user } = useCurrentUser();

  return useQuery({
    queryKey: ["nip29", "livekit-token", relayUrl, groupId, user?.pubkey],
    queryFn: async () => {
      if (!user) throw new Error("Not logged in");
      return fetchLivekitToken(relayUrl, groupId, user.signer);
    },
    enabled: enabled && Boolean(user),
    staleTime: 4 * 60 * 1000,
    retry: 1,
  });
}

/**
 * Live participants of a group's AV room (kind 39004, relay-signed),
 * with a live subscription for presence changes.
 */
export function useLivekitParticipants(relayUrl: string | undefined, groupId: string | undefined) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  const query = useQuery<string[]>({
    queryKey: ["nip29", "livekit-participants", relayUrl, groupId],
    queryFn: async ({ signal }) => {
      const events = await nostr.relay(relayUrl!).query(
        [{ kinds: [KIND_GROUP_PARTICIPANTS], "#d": [groupId!], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
      return latest ? parseGroupParticipants(latest) : [];
    },
    enabled: Boolean(relayUrl && groupId),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  // Subscribe to presence updates.
  useEffect(() => {
    if (!relayUrl || !groupId) return;
    const controller = new AbortController();

    (async () => {
      try {
        for await (const msg of nostr.relay(relayUrl).req(
          [{ kinds: [KIND_GROUP_PARTICIPANTS], "#d": [groupId], since: Math.floor(Date.now() / 1000) }],
          { signal: controller.signal },
        )) {
          if (msg[0] === "EVENT") {
            const event = msg[2] as NostrEvent;
            queryClient.setQueryData<string[]>(
              ["nip29", "livekit-participants", relayUrl, groupId],
              parseGroupParticipants(event),
            );
          }
        }
      } catch {
        // Subscription ended.
      }
    })();

    return () => controller.abort();
  }, [nostr, relayUrl, groupId, queryClient]);

  return query;
}

/** LiveKit identities start with the 64-char hex pubkey; extract it. */
export function pubkeyFromLivekitIdentity(identity: string): string {
  const match = identity.match(/^[0-9a-f]{64}/);
  return match ? match[0] : identity;
}
