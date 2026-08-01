/**
 * Query options shared by every react-query whose `queryFn` is a read of LOCAL
 * storage (ArmadaDB rumors or KV) rather than a network round.
 *
 * These reads are what the app's loading skeletons actually stand for: the gate
 * is `isPending`, which is true from the moment the query mounts until its
 * `queryFn` first resolves. React Query's defaults are tuned for a network
 * fetch, and two of them turn a disk read's brief pending window into a long one:
 *
 *  - `retry: 3` with exponential backoff (1s, 2s, 4s) keeps `status` at
 *    `"pending"` across all four attempts, so one throw — an aborted signal
 *    during a channel switch, a transaction the browser killed — holds a
 *    skeleton for ~7s. A store read that failed will not succeed by being
 *    repeated on a timer; the callers all re-read on the wire bus anyway, and a
 *    query that settles into `error` at least stops claiming to be loading.
 *
 *  - `networkMode: "online"` PAUSES the query while `navigator.onLine` is false
 *    (still `isPending`), i.e. hides on-disk data behind a skeleton for the whole
 *    offline period. That one is defaulted app-wide in `App.tsx`; it is repeated
 *    here so a store read carries its own guarantee rather than inheriting one.
 *
 * Spread FIRST so a caller's own `staleTime`/`refetchInterval` still wins:
 *
 *   useQuery({ ...STORE_READ, queryKey, queryFn, staleTime: 10_000 })
 */
export const STORE_READ = {
  networkMode: "always",
  retry: 0,
} as const;
