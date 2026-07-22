import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNostr } from "@nostrify/react";

import {
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_EDIT,
  KIND_TYPING_INDICATOR,
} from "@/buzz/kinds";
import { buildBuzzReplyTags, buzzThreadRef } from "@/buzz/protocol";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNostrPublish } from "@/hooks/useNostrPublish";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Edit a Buzz stream message: publish a kind-40003 edit whose content is the
 * FULL replacement text, `e`-tagged at the original. Unlike the NIP-29
 * delete-and-republish dance, the original event stays put — every client
 * folds the newest edit onto it (see protocol.ts collectEdits).
 */
export function useBuzzEditMessage(relayUrl: string, channelId: string) {
  const { mutateAsync: publish } = useNostrPublish();

  return useMutation<NostrEvent, Error, { original: NostrEvent; content: string }>({
    mutationFn: async ({ original, content }) => {
      const trimmed = content.trim();
      if (!trimmed) throw new Error("Message cannot be empty");
      if (trimmed === original.content.trim()) return original; // no-op
      return await publish({
        kind: KIND_STREAM_MESSAGE_EDIT,
        content: trimmed,
        tags: [
          ["h", channelId],
          ["e", original.id],
        ],
        relay: relayUrl,
      });
    },
  });
}

/**
 * Post a Buzz thread reply with NIP-10 MARKED `root`/`reply` tags (Buzz's
 * thread model — no kind-1111 comments). `composerTags` are the content-derived
 * tags (mentions/emoji/imeta/hashtags) the shared composer built; its own
 * `h`/`e` structure is replaced by the thread pointers.
 *
 * `replyKind` is the event kind to publish: a stream channel's threads are
 * kind-9 stream messages (the default); a forum channel's threads are kind
 * 45003 forum comments.
 */
export function useSendBuzzThreadReply(
  relayUrl: string,
  channelId: string,
  replyKind: number = KIND_STREAM_MESSAGE,
) {
  const { mutateAsync: publish } = useNostrPublish();
  return useCallback(
    async (root: NostrEvent, content: string, composerTags: string[][] = []) => {
      // Replying "to a root" from the thread panel: the panel always replies
      // to the thread ROOT, so parent = root unless the root is itself a
      // broadcast reply belonging to a deeper thread.
      const ref = buzzThreadRef(root.tags);
      const rootId = ref.rootId ?? root.id;
      const tags = buildBuzzReplyTags(channelId, root.pubkey, root.id, rootId);
      for (const tag of composerTags) {
        if (tag[0] === "h" || tag[0] === "e") continue;
        if (tag[0] === "p" && tags.some(([n, v]) => n === "p" && v === tag[1])) continue;
        tags.push(tag);
      }
      await publish({
        kind: replyKind,
        content,
        tags,
        relay: relayUrl,
      });
    },
    [publish, relayUrl, channelId, replyKind],
  );
}

/** How long a Buzz typing signal is considered live (relay guidance: ~10s). */
const TYPING_WINDOW_MS = 8_000;
/** Minimum gap between published typing signals. */
const TYPING_THROTTLE_MS = 4_000;

/**
 * Live "who is typing" for a Buzz channel: ephemeral kind-20002 events
 * (`h`-scoped, empty content, never stored). Subscription-only — a live
 * `req()` on the host relay feeds a decaying in-memory map — plus a throttled
 * publisher for the viewer's own signal.
 */
export function useBuzzTyping(
  relayUrl: string | undefined,
  channelId: string | undefined,
): { typers: string[]; publishTyping: () => void } {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const [typers, setTypers] = useState<string[]>([]);
  const seen = useRef(new Map<string, number>());
  const lastSent = useRef(0);

  useEffect(() => {
    seen.current = new Map();
    setTypers([]);
    if (!relayUrl || !channelId) return;
    const controller = new AbortController();

    const recompute = () => {
      const now = Date.now();
      const live: string[] = [];
      for (const [pk, ms] of seen.current) {
        if (now - ms <= TYPING_WINDOW_MS) live.push(pk);
        else seen.current.delete(pk);
      }
      setTypers((prev) =>
        prev.length === live.length && prev.every((p, i) => p === live[i]) ? prev : live,
      );
    };

    void (async () => {
      try {
        for await (const msg of nostr.relay(relayUrl).req(
          [{ kinds: [KIND_TYPING_INDICATOR], "#h": [channelId], since: Math.floor(Date.now() / 1000) }],
          { signal: controller.signal },
        )) {
          if (msg[0] !== "EVENT") continue;
          const ev = msg[2] as NostrEvent;
          if (user && ev.pubkey === user.pubkey) continue;
          seen.current.set(ev.pubkey, Date.now());
          recompute();
        }
      } catch {
        // Subscription ended (abort or relay closed).
      }
    })();

    const decay = setInterval(recompute, TYPING_WINDOW_MS / 2);
    return () => {
      controller.abort();
      clearInterval(decay);
    };
    // `user` is only read for self-suppression; keyed on the pubkey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, relayUrl, channelId, user?.pubkey]);

  const publishTyping = useCallback(() => {
    if (!user || !relayUrl || !channelId) return;
    const now = Date.now();
    if (now - lastSent.current < TYPING_THROTTLE_MS) return;
    lastSent.current = now;
    void (async () => {
      try {
        const event = await user.signer.signEvent({
          kind: KIND_TYPING_INDICATOR,
          content: "",
          tags: [["h", channelId]],
          created_at: Math.floor(now / 1000),
        });
        await nostr.relay(relayUrl).event(event, { signal: AbortSignal.timeout(6000) });
      } catch {
        // Best-effort; typing is ephemeral.
      }
    })();
  }, [nostr, user, relayUrl, channelId]);

  return { typers, publishTyping };
}
