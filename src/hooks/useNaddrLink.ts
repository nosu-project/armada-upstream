import { useCallback, useEffect, useMemo, useState } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { toast } from "@/hooks/useToast";
import { writeClipboardText } from "@/lib/clipboard";
import { eventNaddr, naddrShareUrl } from "@/lib/naddrLink";
import { normalizeRelayUrl } from "@/lib/platform";

import type { NostrRumor } from "@/lib/nostrRumor";

/** The app relays as naddr hints — where Discover finds addressable events. */
function useAppRelayHints(): string[] {
  const { config } = useAppContext();
  return useMemo(
    () => [...new Set(config.appRelays.map(normalizeRelayUrl).filter((u): u is string => !!u))],
    [config.appRelays],
  );
}

/** `copied` flips briefly after a copy; only failures toast. */
export function useNaddrLink(event: NostrRumor) {
  const relays = useAppRelayHints();
  const naddr = useMemo(() => eventNaddr(event, relays), [event, relays]);
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

/** For an event not on screen yet (just published); success toasts too since there's no button. */
export function useCopyNaddrLink() {
  const relays = useAppRelayHints();
  return useCallback(
    (event: NostrRumor): (() => void) | undefined => {
      const naddr = eventNaddr(event, relays);
      if (!naddr) return undefined;
      const url = naddrShareUrl(naddr);
      return () => {
        writeClipboardText(url).then(
          () => toast({ title: "Link copied" }),
          () => toast({ title: "Copy failed", variant: "destructive" }),
        );
      };
    },
    [relays],
  );
}
