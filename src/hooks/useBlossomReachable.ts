import { useQuery } from "@tanstack/react-query";

/** A hash no one has uploaded: a live server answers 404, a proxy over a dead one 5xx. */
const PROBE_HASH = "0".repeat(64);

/**
 * Whether a Blossom server answers right now: `undefined` while checking. A
 * BUD-01 HEAD for a missing blob, since the root of many servers is a static
 * page that stays up when the blob store behind it is down.
 */
export function useBlossomReachable(server: string): boolean | undefined {
  const { data, status } = useQuery({
    queryKey: ["blossom-reachable", server],
    queryFn: async ({ signal }) => {
      const res = await fetch(`${server}${PROBE_HASH}`, {
        method: "HEAD",
        signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
      });
      return res.status < 500;
    },
    staleTime: 60_000,
    retry: false,
  });
  if (status === "error") return false;
  return data;
}
