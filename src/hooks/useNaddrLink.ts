import { useCallback, useEffect, useMemo, useState } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { toast } from "@/hooks/useToast";
import { writeClipboardText } from "@/lib/clipboard";
import { eventNaddr, naddrShareUrl } from "@/lib/naddrLink";
import { normalizeRelayUrl } from "@/lib/platform";

import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * An addressable event's naddr (hinted with the app relays, which is where
 * Discover finds it) and a copy action for its shareable URL. `copied` flips
 * for a moment after a successful copy — the button's check mark is the
 * confirmation, so only a failure toasts.
 */
export function useNaddrLink(event: NostrRumor) {
  const { config } = useAppContext();
  const naddr = useMemo(() => {
    const relays = [...new Set(config.appRelays.map(normalizeRelayUrl).filter((u): u is string => !!u))];
    return eventNaddr(event, relays);
  }, [event, config.appRelays]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(() => {
    if (!naddr) return;
    writeClipboardText(naddrShareUrl(naddr)).then(
      () => setCopied(true),
      () => toast({ title: "Copy failed", variant: "destructive" }),
    );
  }, [naddr]);

  return { naddr, copied, copy };
}
