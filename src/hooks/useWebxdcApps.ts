import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import type { NostrEvent } from "@nostrify/nostrify";

import { WEBXDC_MIMES, isWebxdcMime } from "@/lib/webxdcMime";

/** NIP-94 file-metadata kind — how webxdc apps are published as discoverable events. */
const KIND_FILE_METADATA = 1063;


/** A webxdc app discovered from a published kind-1063 event. */
export interface WebxdcApp {
  id: string;
  url: string;
  /** Display name (manifest name / `alt`), or a filename fallback. */
  name: string;
  /** Icon URL (NIP-94 `image`/`thumb`), if the publisher included one. */
  icon?: string;
  /** The publisher's pubkey — used to filter by follows. */
  author: string;
  createdAt: number;
}

function tag(ev: NostrEvent, name: string): string | undefined {
  return ev.tags.find((t) => t[0] === name)?.[1];
}

function deriveName(ev: NostrEvent, url: string): string {
  // ditto publishes `alt` as "Webxdc app: <name>"; strip that prefix.
  const alt = tag(ev, "alt")?.replace(/^webxdc app:\s*/i, "").trim();
  const summary = tag(ev, "summary")?.trim();
  const name = tag(ev, "name")?.trim();
  const fromUrl = decodeURIComponent(url.split(/[?#]/)[0].split("/").pop() ?? "")
    .replace(/\.xdc$/i, "")
    .trim();
  return alt || summary || name || fromUrl || "Webxdc app";
}

/**
 * Discover webxdc apps published as NIP-94 kind-1063 events, from the default
 * pool plus extra `relays`. Deduped by `.xdc` URL, newest-first.
 */
export function useWebxdcApps(relays?: string[]) {
  const { nostr } = useNostr();
  const extra = relays ?? [];
  return useQuery<WebxdcApp[]>({
    queryKey: ["webxdc-apps", [...extra].sort().join(",")],
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }) => {
      // Both MIME spellings, or apps predating the MIME change disappear.
      const filter = { kinds: [KIND_FILE_METADATA], "#m": [...WEBXDC_MIMES], limit: 200 };
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
      const results = await Promise.all([
        nostr.query([filter], { signal: timeout }).catch(() => [] as NostrEvent[]),
        ...extra.map((url) =>
          nostr.relay(url).query([filter], { signal: timeout }).catch(() => [] as NostrEvent[]),
        ),
      ]);
      const events = results.flat().sort((a, b) => b.created_at - a.created_at);
      const byUrl = new Map<string, WebxdcApp>();
      for (const ev of events) {
        const url = tag(ev, "url");
        if (!url || !isWebxdcMime(tag(ev, "m")) || byUrl.has(url)) continue;
        byUrl.set(url, {
          id: ev.id,
          url,
          name: deriveName(ev, url),
          icon: tag(ev, "image") ?? tag(ev, "thumb"),
          author: ev.pubkey,
          createdAt: ev.created_at,
        });
      }
      return [...byUrl.values()];
    },
  });
}
