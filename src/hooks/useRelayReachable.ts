import { useQuery } from "@tanstack/react-query";

import { relayInfoQueryOptions } from "@/hooks/useRelayInfo";

/**
 * Whether a relay answers right now: `undefined` while checking. Rides the NIP-11 query with a
 * shorter staleTime, so a row showing both the relay's identity and this light costs one GET.
 * Its disk seed (`dataUpdatedAt: 0`) is last-known-good and says nothing about the relay being up.
 */
export function useRelayReachable(url: string | undefined): boolean | undefined {
  const { status, dataUpdatedAt } = useQuery({ ...relayInfoQueryOptions(url), staleTime: 60_000 });
  if (status === "error") return false;
  return dataUpdatedAt > 0 ? true : undefined;
}
