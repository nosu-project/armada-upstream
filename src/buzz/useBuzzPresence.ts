import { useNostr } from "@nostrify/react";
import { useEffect, useRef, useState } from "react";

import { KIND_PRESENCE } from "@/buzz/kinds";
import { useCurrentUser } from "@/hooks/useCurrentUser";

import type { NostrEvent } from "@nostrify/nostrify";

/** A presence heartbeat is live for this long (relay TTL is 90s). */
const PRESENCE_WINDOW_MS = 90_000;
/** Heartbeat interval for the viewer's own presence (Buzz clients use 30s). */
const HEARTBEAT_MS = 30_000;

export type BuzzPresenceState = "online" | "away";

/**
 * Live presence for a Buzz relay: ephemeral kind-20001 heartbeats (content
 * "online"/"away", never stored, 90s TTL). Holds ONE live subscription while
 * mounted, decays entries past the window, and — when the viewer is signed in
 * — publishes their own "online" heartbeat every 30s so other Buzz clients
 * see them too. Presence fills in as members heartbeat (≤30s after mount).
 */
export function useBuzzPresence(relayUrl: string | undefined): Record<string, BuzzPresenceState> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const [presence, setPresence] = useState<Record<string, BuzzPresenceState>>({});
  const seen = useRef(new Map<string, { state: BuzzPresenceState; ms: number }>());

  useEffect(() => {
    seen.current = new Map();
    setPresence({});
    if (!relayUrl) return;
    const controller = new AbortController();

    const recompute = () => {
      const now = Date.now();
      const next: Record<string, BuzzPresenceState> = {};
      for (const [pk, entry] of seen.current) {
        if (now - entry.ms <= PRESENCE_WINDOW_MS) next[pk] = entry.state;
        else seen.current.delete(pk);
      }
      setPresence((prev) => {
        const prevKeys = Object.keys(prev);
        const nextKeys = Object.keys(next);
        if (prevKeys.length === nextKeys.length && nextKeys.every((k) => prev[k] === next[k])) {
          return prev;
        }
        return next;
      });
    };

    void (async () => {
      try {
        for await (const msg of nostr.relay(relayUrl).req(
          [{ kinds: [KIND_PRESENCE], since: Math.floor(Date.now() / 1000) - 90 }],
          { signal: controller.signal },
        )) {
          if (msg[0] !== "EVENT") continue;
          const ev = msg[2] as NostrEvent;
          const raw = ev.content.trim().toLowerCase();
          if (raw === "offline") {
            seen.current.delete(ev.pubkey);
          } else {
            seen.current.set(ev.pubkey, { state: raw === "away" ? "away" : "online", ms: Date.now() });
          }
          recompute();
        }
      } catch {
        // Subscription ended (abort or relay closed).
      }
    })();

    const decay = setInterval(recompute, PRESENCE_WINDOW_MS / 3);
    return () => {
      controller.abort();
      clearInterval(decay);
    };
  }, [nostr, relayUrl]);

  // The viewer's own heartbeat (visible tab = online; hidden pauses).
  useEffect(() => {
    if (!relayUrl || !user) return;
    let cancelled = false;

    const beat = async () => {
      if (cancelled || document.visibilityState !== "visible") return;
      try {
        const event = await user.signer.signEvent({
          kind: KIND_PRESENCE,
          content: "online",
          tags: [["status", "online"]],
          created_at: Math.floor(Date.now() / 1000),
        });
        if (!cancelled) {
          await nostr.relay(relayUrl).event(event, { signal: AbortSignal.timeout(6000) });
        }
      } catch {
        // Best-effort; presence is ephemeral.
      }
    };

    void beat();
    const timer = setInterval(() => void beat(), HEARTBEAT_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void beat();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [nostr, relayUrl, user]);

  return presence;
}
