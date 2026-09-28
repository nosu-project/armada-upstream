import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

/** `"pending"` while publishing, `"failed"` if no relay accepted it; absent = confirmed. */
export type SendStatus = "pending" | "failed";

export type SendStatusMap = Record<string, SendStatus>;

/**
 * Per-channel optimistic status map in its own react-query entry, shared by NIP-29 and Concord.
 * Pass `undefined` key segments to disable until ready.
 */
export function useSendStatusMap(queryKey: readonly unknown[]): {
  status: SendStatusMap;
  setStatus: (id: string, value: SendStatus | undefined) => void;
} {
  const queryClient = useQueryClient();

  const { data: status = {} } = useQuery<SendStatusMap>({
    queryKey,
    queryFn: () => ({}),
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const setStatus = useCallback(
    (id: string, value: SendStatus | undefined) => {
      queryClient.setQueryData<SendStatusMap>(queryKey, (old = {}) => {
        if (value === undefined) {
          if (!(id in old)) return old;
          const next = { ...old };
          delete next[id];
          return next;
        }
        if (old[id] === value) return old;
        return { ...old, [id]: value };
      });
    },
    // Spread the key so the callback is stable for the same logical key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient, ...queryKey],
  );

  return { status, setStatus };
}

export function useSendStatusMapValue(queryKey: readonly unknown[]): SendStatusMap {
  const { data = {} } = useQuery<SendStatusMap>({
    queryKey,
    queryFn: () => ({}),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data;
}
