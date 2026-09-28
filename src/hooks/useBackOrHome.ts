import { useCallback } from "react";

import { useStableNavigate } from "@/hooks/useStableNavigate";

/**
 * Page-level Back: step back if there's an in-app entry, else replace with
 * `fallback`. Uses the router's entry index (0 on a cold load); `history.length`
 * counts other sites too.
 */
export function useBackOrHome(fallback = "/"): () => void {
  const navigate = useStableNavigate();
  return useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate(fallback, { replace: true });
  }, [navigate, fallback]);
}
