import { useQuery } from "@tanstack/react-query";

import { relayToHttpUrl } from "@/lib/platform";

/** HEAD for the NIP-11 document; with only the `application/nostr+json` accept it's a simple CORS request (no preflight). */
async function probeRelay(url: string, signal: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(relayToHttpUrl(url), {
      method: "HEAD",
      headers: { accept: "application/nostr+json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Whether a relay answers right now: `undefined` while checking. Separate from `useRelayInfo`,
 * whose disk-seeded last-known-good document says nothing about the relay being up.
 */
export function useRelayReachable(url: string | undefined): boolean | undefined {
  const { data } = useQuery({
    queryKey: ["relay-reachable", url],
    queryFn: ({ signal }) => probeRelay(url!, signal),
    enabled: !!url && /^wss?:\/\//i.test(url),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    retry: false,
  });
  return data;
}
