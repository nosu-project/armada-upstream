import { useCallback } from "react";

import { useStableNavigate } from "@/hooks/useStableNavigate";

/**
 * A page-level Back: one step back when there is an entry IN THE APP to return
 * to, otherwise `fallback` (home by default), replacing the current entry.
 *
 * A cold load (a shared link, a fresh tab) has nothing in the app behind it.
 * `history.length` can't tell: it counts the tab's earlier sites too, and
 * stepping back to one would leave Armada. The router's own entry index can —
 * it is 0 on the entry the app was loaded into.
 */
export function useBackOrHome(fallback = "/"): () => void {
  const navigate = useStableNavigate();
  return useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate(fallback, { replace: true });
  }, [navigate, fallback]);
}
