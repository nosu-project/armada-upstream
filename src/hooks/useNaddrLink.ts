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

/**
 * An addressable event's naddr (hinted with the app relays, which is where
 * Discover finds it) and a copy action for its shareable URL. `copied` flips
 * for a moment after a successful copy — the button's check mark is the
 * confirmation, so only a failure toasts.
 */
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

/**
 * {@link useNaddrLink}'s link for an event that isn't on screen yet — one just
 * published, whose success toast offers it. Returns a copy action for the
 * event's shareable URL (same relay hints as the cards), or undefined for an
 * event that has no naddr. There is no button left to carry a check mark once
 * the toast's action dismisses it, so success toasts too.
 */
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
