/**
 * NIP-17 typing indicators — the DM plane's one EPHEMERAL action.
 *
 * A kind-23311 rumor (the same kind Concord uses in its channels) sealed
 * NIP-59-style and carried in a kind-21059 ephemeral gift wrap, so relays
 * broadcast it to whoever is listening and store nothing. Wire format lives in
 * `src/lib/nip17/protocol.ts`; this hook owns the relay traffic:
 *
 *   - RECEIVE: a live `{kinds:[21059], "#p":[me]}` sub on the same relay set
 *     the inbox sync reads, feeding a decaying in-memory map. Nothing is ever
 *     written to the rumor store or the signer's decrypt cache.
 *   - SEND: throttled to one signal per TYPING_THROTTLE_MS, sealed to the peer
 *     ONLY (no self copy — you don't need your own typing indicator) and
 *     published to the peer's kind-10050 inbox ∪ our own DM relays, the same
 *     targets a message wrap goes to.
 *
 * One thing gates this: `config.dmTypingIndicators`. Every login that can do
 * NIP-44 participates — the send path is throttled to one signal per
 * TYPING_THROTTLE_MS and a missed signal costs nothing, so there is no signer
 * fast enough to require and none slow enough to have to exclude.
 */

import { useNostr } from "@nostrify/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDmRelayList, useDmRelaysFor } from "@/hooks/useDmRelayList";
import { effectiveDmRelays } from "@/contexts/AppContext";
import {
  buildDmRumor,
  dmConvKey,
  dmConvPeers,
  dmTypingTags,
  KIND_DM_TYPING,
  KIND_DM_WRAP_EPHEMERAL,
  openDmWrap,
  sealDmRumor,
  TYPING_WINDOW_SECS,
  wrapDmSealEphemeral,
  type Dm17Signer,
} from "@/lib/nip17/protocol";

import type { NostrEvent } from "@nostrify/nostrify";

/** How long a received signal keeps the indicator up. */
const TYPING_WINDOW_MS = TYPING_WINDOW_SECS * 1000;
/** Minimum gap between published signals — one every 4s covers an 8s window. */
const TYPING_THROTTLE_MS = 4_000;

export interface DmTyping {
  /** Participants currently typing (sorted); empty when nobody is. */
  typers: string[];
  /** Fire on every keystroke; throttled internally. No-op when disabled. */
  publishTyping: () => void;
}

const IDLE: DmTyping = { typers: [], publishTyping: () => {} };

/**
 * Live "is this peer typing" for one NIP-17 conversation, plus a throttled
 * publisher for our own signal. Returns an inert value whenever the feature is
 * off, the signer can't do it, or there's no peer — callers can mount it
 * unconditionally.
 */
export function useDmTyping(conversation: string | undefined, enabled = true): DmTyping {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { relays: publishedRelays } = useDmRelayList();

  const self = user?.pubkey;
  const peers = useMemo(
    () => (conversation ? dmConvPeers(conversation) : []),
    [conversation],
  );
  // The one peer we publish OUR signal to. Groups deliberately receive but do
  // not send: a signal has to be sealed per recipient, and a sequential signer
  // round-trip per member every TYPING_THROTTLE_MS is a real cost on a bunker
  // (and a visible one on a NIP-07 extension that prompts). Somebody else's
  // signal still lights the indicator, so the feature degrades to one-way
  // rather than off.
  const publishPeer = peers.length === 1 && peers[0] !== self ? peers[0] : undefined;
  const peerInboxRelays = useDmRelaysFor(publishPeer);
  const senders = useMemo(() => new Set(peers), [peers]);

  const [typers, setTypers] = useState<string[]>([]);
  /** Newest signal timestamp (ms) per participant, for the decay sweep. */
  const lastSeen = useRef(new Map<string, number>());
  const lastSent = useRef(0);

  const on =
    enabled &&
    config.dmTypingIndicators &&
    // The whole-DM opt-out: with DMs off we neither publish our own typing
    // signal (`publishTyping` gates on `on`) nor hold the standing 21059 sub.
    !config.dmsDisabled &&
    !!self &&
    peers.length > 0 &&
    // A note-to-self thread would just show us our own indicator.
    !(peers.length === 1 && peers[0] === self) &&
    !!user?.signer.nip44;

  // The same union the inbox sync reads from: our effective DM relays ∪ our
  // published kind-10050 inbox. A sender following NIP-17 delivers to the
  // latter, so a signal would be missed if we only watched the former.
  const myRelays = useMemo(
    () => [...new Set([...effectiveDmRelays(config), ...publishedRelays])],
    [config, publishedRelays],
  );
  const myRelayKey = myRelays.join(",");
  const peerRelayKey = peerInboxRelays.join(",");
  const conversationKey = conversation ?? "";

  useEffect(() => {
    setTypers([]);
    lastSeen.current = new Map();
    if (!on || myRelays.length === 0) return;
    const controller = new AbortController();
    const signer = user!.signer as unknown as Dm17Signer;

    const recompute = () => {
      const cutoff = Date.now() - TYPING_WINDOW_MS;
      const live: string[] = [];
      for (const [pubkey, at] of lastSeen.current) {
        if (at > cutoff) live.push(pubkey);
        else lastSeen.current.delete(pubkey);
      }
      live.sort();
      setTypers((prev) =>
        prev.length === live.length && prev.every((pk, i) => pk === live[i]) ? prev : live,
      );
    };

    const apply = async (wrap: NostrEvent) => {
      // No cache: an 8-second signal must not leave plaintext on disk.
      const opened = await openDmWrap(wrap, signer, self!, {
        wrapKind: KIND_DM_WRAP_EPHEMERAL,
        cache: false,
      }).catch(() => undefined);
      if (!opened || opened.kind !== KIND_DM_TYPING) return;
      // Only THIS conversation, and never our own signal echoing back off a
      // shared relay (we publish to our own DM relays too). The author check is
      // what excludes our own copy; the conversation check is what keeps a
      // signal from a 1:1 out of a group that shares its members.
      if (!senders.has(opened.author)) return;
      if (dmConvKey(opened.peers) !== conversationKey) return;
      const ms = opened.createdAt * 1000;
      if (Date.now() - ms > TYPING_WINDOW_MS) return;
      if (ms <= (lastSeen.current.get(opened.author) ?? 0)) return;
      lastSeen.current.set(opened.author, ms);
      recompute();
    };

    for (const url of myRelays) {
      void (async () => {
        try {
          for await (const msg of nostr.relay(url).req(
            [{ kinds: [KIND_DM_WRAP_EPHEMERAL], "#p": [self!], since: Math.floor(Date.now() / 1000) }],
            { signal: controller.signal },
          )) {
            if (msg[0] === "EVENT") void apply(msg[2] as NostrEvent);
          }
        } catch (err) {
          // Teardown aborts every sub; only a real failure is worth reporting.
          // A relay that rejects kind 21059 (or the filter) surfaces here, and
          // silence made that indistinguishable from "nobody is typing".
          if (!controller.signal.aborted) {
            console.warn(`[dm-typing] subscription to ${url} ended:`, err);
          }
        }
      })();
    }

    const decay = setInterval(recompute, TYPING_WINDOW_MS / 2);
    return () => {
      controller.abort();
      clearInterval(decay);
    };
    // `user` is read for its signer; keyed on the pubkey (the signer is stable
    // per login) so a profile refresh doesn't tear down the subscriptions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, on, self, conversationKey, myRelayKey]);

  const publishTyping = useCallback(() => {
    if (!on || !publishPeer) return;
    const now = Date.now();
    if (now - lastSent.current < TYPING_THROTTLE_MS) return;
    lastSent.current = now;
    void (async () => {
      try {
        const signer = user!.signer as unknown as Dm17Signer;
        const rumor = buildDmRumor({
          kind: KIND_DM_TYPING,
          content: "",
          tags: dmTypingTags([publishPeer]),
          pubkey: self!,
        });
        // Peer copy only — a self copy would just be our own indicator coming
        // back at us, at double the relay traffic.
        const wrap = wrapDmSealEphemeral(await sealDmRumor(rumor, publishPeer, signer), publishPeer);
        const targets = [...new Set([...peerInboxRelays, ...myRelays])];
        await Promise.allSettled(
          targets.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(6000) })),
        );
      } catch {
        // Best-effort; typing is ephemeral and a miss costs nothing.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, on, self, publishPeer, user, myRelayKey, peerRelayKey]);

  return on ? { typers, publishTyping } : IDLE;
}
