import { useNostr } from "@nostrify/react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { authorQueryOptions } from "@/hooks/useAuthor";
import { useEventStore } from "@/hooks/useEventStore";
import { mentionLabel } from "@/lib/composerText";
import { demandProfiles } from "@/sync/profileSync";

/**
 * `@Name` for each pubkey, as the composer shows a mention. Identity is stable
 * while the names are, so the display model isn't rebuilt per render.
 */
export function useMentionLabels(pubkeys: readonly string[]): (pubkey: string) => string {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const key = pubkeys.join(",");

  useEffect(() => {
    if (!key) return;
    return demandProfiles(key.split(","), { nostr, queryClient });
  }, [key, nostr, queryClient]);

  const results = useQueries({
    queries: pubkeys.map((pk) => authorQueryOptions(queryClient, eventStore, pk)),
  });

  const signature = JSON.stringify(
    results.map((r, i) => [pubkeys[i], r.data?.metadata?.name || r.data?.metadata?.display_name || ""]),
  );

  return useMemo(() => {
    const names = new Map<string, string>(JSON.parse(signature) as Array<[string, string]>);
    return (pubkey: string) => mentionLabel(names.get(pubkey), pubkey);
  }, [signature]);
}
