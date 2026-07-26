/**
 * NIP-17 typing indicators — the DM plane's one EPHEMERAL action.
 *
 * A kind-23311 rumor (the same kind Concord V2 uses in its channels) sealed
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
 * Two things gate this, both deliberately conservative:
 *
 *   - The user must opt in (`config.dmTypingIndicators`, default off). A steady
 *     signal every few seconds tells the relay that this conversation is live
 *     RIGHT NOW, at a resolution the ordinary DM flow — batched and backdated up
 *     to two days by NIP-59 — does not give it. That's a real metadata
 *     regression, so it isn't made for anyone silently.
 *   - The signer must not prompt (`nsec` logins only). Every signal costs a
 *     nip44 encrypt plus a signEvent, and every received one costs two
 *     decrypts; on a NIP-07 extension or a NIP-46 bunker that's an approval
 *     storm every few seconds, which is worse than having no feature.
 */

import { useNostr } from "@nostrify/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDmRelayList, useDmRelaysFor } from "@/hooks/useDmRelayList";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { signerNeedsApproval } from "@/lib/bulkDecryptGate";
import {
  buildDmRumor,
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
  /** The peer, when they're currently typing; empty otherwise. */
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
export function useDmTyping(peer: string | undefined, enabled = true): DmTyping {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { relays: publishedRelays } = useDmRelayList();
  const peerInboxRelays = useDmRelaysFor(peer);

  const [typers, setTypers] = useState<string[]>([]);
  const lastSeen = useRef(0);
  const lastSent = useRef(0);

  const self = user?.pubkey;
  // Silent signers only: see the module doc. `nsec` is the one login that
  // encrypts and signs inline with an in-memory key.
  const silentSigner = !!user && !signerNeedsApproval(user.method);
  const on =
    enabled &&
    config.dmTypingIndicators &&
    silentSigner &&
    !!self &&
    !!peer &&
    // A note-to-self thread would just show us our own indicator.
    peer !== self &&
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

  useEffect(() => {
    setTypers([]);
    lastSeen.current = 0;
    if (!on || myRelays.length === 0) return;
    const controller = new AbortController();
    const signer = user!.signer as unknown as Dm17Signer;

    const recompute = () => {
      const live = Date.now() - lastSeen.current <= TYPING_WINDOW_MS;
      setTypers((prev) => (prev.length === (live ? 1 : 0) ? prev : live ? [peer!] : []));
    };

    const apply = async (wrap: NostrEvent) => {
      // No cache: an 8-second signal must not leave plaintext on disk.
      const opened = await openDmWrap(wrap, signer, self!, {
        wrapKind: KIND_DM_WRAP_EPHEMERAL,
        cache: false,
      }).catch(() => undefined);
      if (!opened || opened.kind !== KIND_DM_TYPING) return;
      // Only THIS conversation, and never our own signal echoing back off a
      // shared relay (we publish to our own DM relays too).
      if (opened.author !== peer || opened.peer !== peer) return;
      const ms = opened.createdAt * 1000;
      if (Date.now() - ms > TYPING_WINDOW_MS) return;
      if (ms <= lastSeen.current) return;
      lastSeen.current = ms;
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
        } catch {
          // Subscription ended (abort, relay closed, or no ephemeral support).
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
  }, [nostr, on, self, peer, myRelayKey]);

  const publishTyping = useCallback(() => {
    if (!on) return;
    const now = Date.now();
    if (now - lastSent.current < TYPING_THROTTLE_MS) return;
    lastSent.current = now;
    void (async () => {
      try {
        const signer = user!.signer as unknown as Dm17Signer;
        const rumor = buildDmRumor({
          kind: KIND_DM_TYPING,
          content: "",
          tags: dmTypingTags(peer!),
          pubkey: self!,
        });
        // Peer copy only — a self copy would just be our own indicator coming
        // back at us, at double the relay traffic.
        const wrap = wrapDmSealEphemeral(await sealDmRumor(rumor, peer!, signer), peer!);
        const targets = [...new Set([...peerInboxRelays, ...myRelays])];
        await Promise.allSettled(
          targets.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(6000) })),
        );
      } catch {
        // Best-effort; typing is ephemeral and a miss costs nothing.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, on, self, peer, user, myRelayKey, peerRelayKey]);

  return on ? { typers, publishTyping } : IDLE;
}
