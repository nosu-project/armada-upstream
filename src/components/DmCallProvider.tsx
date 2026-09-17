import { useNostr } from "@nostrify/react";
import { Phone, PhoneOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { DmAvatar } from "@/components/DmAvatar";
import { DisplayName } from "@/components/DisplayName";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/hooks/useAppContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useCall } from "@/hooks/useCall";
import { useVoiceActivity } from "@/hooks/useVoiceActivity";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDmRelayList } from "@/hooks/useDmRelayList";
import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";
import { useToast } from "@/hooks/useToast";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { DmCallContext, type DmCallState } from "@/contexts/DmCallContext";
import { inviteDeliveryRelays, recipientInboxRelays } from "@/concord/lib/inviteRelays";
import { STOCK_RELAYS } from "@/concord/lib/invite";
import { ownAvServers } from "@/concord/hooks/useVoice";
import { canonicalOrigin, probeAvBroker } from "@/concord/lib/voice";
import { consumeNativeCallAnswer } from "@/lib/nativeNotifications";
import {
  startIncomingRing,
  startRingback,
  stopIncomingRing,
  stopRingback,
} from "@/lib/callSounds";
import {
  DM_CALL_RING_MS,
  deliverDmCallRumors,
  dmCallKeys,
  dmCallTags,
  isDmOfferFresh,
  mintDmCall,
  subscribeDmCallSignals,
  type DmCallPhase,
  type DmCallSignal,
} from "@/lib/dmCall";
import { getDisplayName } from "@/lib/getDisplayName";
import {
  buildDmRumor,
  KIND_DM_CALL,
  KIND_DM_WRAP_EPHEMERAL,
  openDmWrap,
  sealDmRumor,
  wrapDmSealEphemeral,
  type Dm17Signer,
} from "@/lib/nip17/protocol";

import type { DmVoiceContext } from "@/contexts/CallContext";
import type { NostrEvent } from "@nostrify/nostrify";

/**
 * DM call signaling (see `src/lib/dmCall.ts` for the wire scheme). Owns:
 *
 *   - OUTGOING: `startCall` mints the per-call secret, resolves a blind
 *     broker, publishes the gift-wrapped "offer" (the ring signal), joins the
 *     room, and rings back until the peer answers — or times out after
 *     {@link DM_CALL_RING_MS} with an "end" so the peer's ring stops too.
 *   - INCOMING: a fresh offer from a KNOWN DM peer (one the user follows,
 *     has messaged/accepted, or pinned — the same `useKnownDmPeers` set the
 *     inbox/request split uses, muted peers excluded) rings a full-screen
 *     overlay (Accept / Decline) with a looping ringtone. The gate is on
 *     purpose: the offer's author controls their name and avatar, so a cold
 *     stranger must not be able to make a phone ring on demand — their offer
 *     is dropped silently and the conversation itself still shows their
 *     messages in the request tier. A known caller who arrives while the user
 *     is already in another call gets a passive "Missed call" notice rather
 *     than vanishing. Muting a peer silences their calls like everything else.
 *   - The signal fold: "answer" stops the caller's ringback (and, as an own
 *     self-copy, other devices' ringing); "decline" ends the caller's attempt;
 *     "end" is both cancel-while-ringing and hangup — while connected to that
 *     call it hangs up this side too, which is what makes a 1:1 call END when
 *     either party leaves rather than stranding one person in an empty room.
 *
 * Mounted inside CallProvider (it drives joinDmCall/leaveCall) and inside the
 * router (the Android incoming-call notification's Answer action deep-links
 * `/dm/<peer>?call=<id>`, which accepts the matching offer — one already in
 * hand, or the one the service vetted before it rang). The URL names a call
 * and authorizes nothing; see the deep-link effect below.
 */
export function DmCallProvider({ children }: { children: React.ReactNode }) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { relays: publishedRelays } = useDmRelayList();
  const { knownPeers } = useKnownDmPeers();
  const { activeCall, joinDmCall, leaveCall } = useCall();
  const { voiceRoomPubkeys } = useVoiceActivity();
  const { toast } = useToast();
  const location = useLocation();
  const navigate = useNavigate();

  const [incoming, setIncoming] = useState<DmCallSignal | null>(null);
  /** The outgoing attempt currently ringing (cleared once answered/ended). */
  const outgoingRef = useRef<{ callId: string; peer: string; answered: boolean } | null>(null);
  const ringTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const incomingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** An Answer deep link (`?call=<id>`) waiting for its offer to arrive. */
  const pendingAcceptRef = useRef<{ callId: string; at: number } | null>(null);
  /** The call an Answer tap is currently redeeming its ticket for. */
  const answeringRef = useRef<string | null>(null);

  // Live refs so the signal listener (one subscription for the provider's
  // lifetime) always reads current state without re-subscribing.
  const incomingRef = useRef(incoming);
  incomingRef.current = incoming;
  const activeCallRef = useRef(activeCall);
  activeCallRef.current = activeCall;
  // Who may ring us: the same "known DM peer" set (follows ∪ messaged/accepted ∪
  // pinned, muted excluded) that separates the inbox from the request tier, so
  // the ring gate can't disagree with where the conversation itself lands. The
  // Android background ringer applies the mirror of this set (`dmKnownPeers`).
  const knownPeersRef = useRef<readonly string[]>([]);
  knownPeersRef.current = knownPeers;

  // Where our copies publish and our other sessions read: the same union the
  // DM inbox sync and typing indicators use. `dmsDisabled` collapses this to
  // empty, so the standing 21059 call-signal subscription is never held and no
  // inbound call can ring — the whole-DM opt-out covers call signaling too.
  const myRelays = useMemo(
    () =>
      config.dmsDisabled
        ? []
        : [...new Set([...effectiveDmRelays(config), ...publishedRelays])],
    [config, publishedRelays],
  );
  const myRelaysRef = useRef(myRelays);
  myRelaysRef.current = myRelays;

  // The interop STOCK floor, mirrored from the CORD invite path (inviteRelays.ts):
  // a user who has switched off the shared app DM relays AND published no
  // kind-10050 inbox has no rendezvous a caller could resolve, so both sides
  // fall back to the stock set — the caller sends there (via
  // `inviteDeliveryRelays` below) and this scanner listens there, the same set
  // derived the same way so the two always meet. Gated tightly on purpose: a
  // user still on the app DM relays keeps a private floor and never REQs their
  // own `#p` to the public stock relays.
  const scanRelays = useMemo(() => {
    if (myRelays.length === 0) return [];
    const stockFloor = !config.useAppDmRelays && publishedRelays.length === 0 ? STOCK_RELAYS : [];
    return [...new Set([...myRelays, ...stockFloor])];
  }, [myRelays, config.useAppDmRelays, publishedRelays]);
  const scanRelaysRef = useRef(scanRelays);
  scanRelaysRef.current = scanRelays;

  const clearIncoming = useCallback(() => {
    if (incomingTimeoutRef.current) {
      clearTimeout(incomingTimeoutRef.current);
      incomingTimeoutRef.current = null;
    }
    stopIncomingRing();
    setIncoming(null);
  }, []);

  /**
   * Seal + publish one call rumor in an EPHEMERAL (21059) wrap: the peer's
   * copy to the relays where send and scan meet — their published inbox, or the
   * STOCK floor when they've published none (`inviteDeliveryRelays`) ∪ our DM
   * relays — and a best-effort self copy so our other devices fold the same call
   * state (answered/declined elsewhere). Relays broadcast and store nothing.
   * Resolves true when at least one relay accepted the peer's copy.
   */
  const sendSignal = useCallback(
    async (
      phase: DmCallPhase,
      peer: string,
      callId: string,
      extras?: { secretHex?: string; broker?: string },
    ): Promise<boolean> => {
      if (!user?.signer.nip44) return false;
      const signer = user.signer as unknown as Dm17Signer;
      const rumor = buildDmRumor({
        kind: KIND_DM_CALL,
        content: phase,
        tags: dmCallTags(peer, callId, extras),
        pubkey: user.pubkey,
      });
      // A failed inbox lookup (`null`) is NOT "no inbox": don't fan a list-having
      // peer's offer onto the stock floor. `[]` is a confirmed-empty inbox, which
      // `inviteDeliveryRelays` turns into the stock set the peer's own scanner
      // also falls back to.
      const inbox = await recipientInboxRelays(nostr, peer).catch(() => null);
      const floor = inbox === null ? [] : inviteDeliveryRelays(inbox);
      const targets = [...new Set([...floor, ...myRelaysRef.current])];
      if (targets.length === 0) return false;
      const wrap = wrapDmSealEphemeral(await sealDmRumor(rumor, peer, signer), peer);
      const results = await Promise.allSettled(
        targets.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
      );
      // Self copy is best-effort and never gates the send result. It goes to our
      // SCAN set (stock floor included) so a sibling device listening there hears
      // it. "answer"/"decline" are the signals that STOP another device's ring,
      // and a single ephemeral broadcast is lost if that device's socket blips —
      // so re-send those a couple of times over the next few seconds. The wrap is
      // re-broadcast verbatim, so a sibling that already folded it dedupes the
      // retries by rumor id; one that missed the first send now catches up.
      void (async () => {
        try {
          const selfWrap = wrapDmSealEphemeral(
            await sealDmRumor(rumor, user.pubkey, signer),
            user.pubkey,
          );
          const broadcastSelf = () =>
            Promise.allSettled(
              scanRelaysRef.current.map((url) =>
                nostr.relay(url).event(selfWrap, { signal: AbortSignal.timeout(8000) }),
              ),
            );
          await broadcastSelf();
          if (phase === "answer" || phase === "decline") {
            for (const delay of [1500, 4000]) {
              await new Promise((resolve) => setTimeout(resolve, delay));
              await broadcastSelf();
            }
          }
        } catch {
          // A missed self copy costs another device a state fold, nothing more.
        }
      })();
      return results.some((r) => r.status === "fulfilled");
    },
    [nostr, user],
  );

  // The live signal feed: call rumors ride ephemeral wraps, so nothing ever
  // arrives through the durable inbox sync — the provider holds its own
  // standing 21059 subscription on the DM relay union, the same shape as
  // typing indicators but app-wide. Typing signals share the filter and are
  // discarded after decrypt (`cache: false` keeps every open off disk);
  // parsed call rumors feed the bus, which dedupes across relays.
  const scanRelaysKey = scanRelays.join(",");
  useEffect(() => {
    const self = user?.pubkey;
    if (!self || !user?.signer.nip44 || scanRelays.length === 0) return;
    const controller = new AbortController();
    const signer = user.signer as unknown as Dm17Signer;
    for (const url of scanRelays) {
      void (async () => {
        try {
          for await (const msg of nostr.relay(url).req(
            [{ kinds: [KIND_DM_WRAP_EPHEMERAL], "#p": [self], since: Math.floor(Date.now() / 1000) }],
            { signal: controller.signal },
          )) {
            if (msg[0] !== "EVENT") continue;
            void (async () => {
              const opened = await openDmWrap(msg[2] as NostrEvent, signer, self, {
                wrapKind: KIND_DM_WRAP_EPHEMERAL,
                cache: false,
              }).catch(() => undefined);
              if (opened && opened.kind === KIND_DM_CALL) deliverDmCallRumors([opened]);
            })();
          }
        } catch (err) {
          if (!controller.signal.aborted) {
            console.warn(`[dm-call] subscription to ${url} ended:`, err);
          }
        }
      })();
    }
    return () => controller.abort();
    // Keyed on the pubkey (the signer is stable per login), like useDmTyping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, user?.pubkey, scanRelaysKey]);

  const clearOutgoing = useCallback(() => {
    if (ringTimeoutRef.current) {
      clearTimeout(ringTimeoutRef.current);
      ringTimeoutRef.current = null;
    }
    stopRingback();
    outgoingRef.current = null;
  }, []);

  const startCall = useCallback(
    async (peer: string) => {
      if (!user?.signer.nip44) {
        toast({
          title: "Calls unavailable",
          description: "This login can't make encrypted calls (NIP-44 unsupported).",
          variant: "destructive",
        });
        return;
      }
      if (activeCallRef.current) {
        toast({ title: "Already in a call", description: "Leave the current call first." });
        return;
      }
      // Resolve a reachable blind broker from our own defaults (the offer
      // carries the winner as the rendezvous hint, like Concord presence).
      let broker: string | null = null;
      for (const origin of ownAvServers()) {
        if (await probeAvBroker(origin)) {
          broker = origin;
          break;
        }
      }
      if (!broker) {
        toast({
          title: "Could not start the call",
          description: "No voice server is reachable.",
          variant: "destructive",
        });
        return;
      }
      const { secretHex, callId } = mintDmCall();
      const sent = await sendSignal("offer", peer, callId, { secretHex, broker }).catch(() => false);
      if (!sent) {
        toast({
          title: "Could not start the call",
          description: "The call invite could not be delivered to any relay.",
          variant: "destructive",
        });
        return;
      }
      const ctx: DmVoiceContext = { peer, callId, secretHex, broker };
      outgoingRef.current = { callId, peer, answered: false };
      joinDmCall(ctx);
      startRingback();
      ringTimeoutRef.current = setTimeout(() => {
        const out = outgoingRef.current;
        if (!out || out.callId !== callId || out.answered) return;
        // Nobody picked up: end our side; the leave effect below sends "end"
        // so the peer's (possibly still undelivered) ring stops too.
        clearOutgoing();
        leaveCall();
        toast({ title: "No answer" });
      }, DM_CALL_RING_MS);
    },
    [user, toast, sendSignal, joinDmCall, leaveCall, clearOutgoing],
  );

  const acceptCall = useCallback(() => {
    const offer = incomingRef.current;
    if (!offer?.secretHex || !offer.broker) return;
    clearIncoming();
    // Fire-and-forget: the answer stops the caller's ringback and our other
    // devices' ringing; joining the room is what actually connects the call.
    void sendSignal("answer", offer.author, offer.callId).catch(() => undefined);
    joinDmCall({
      peer: offer.author,
      callId: offer.callId,
      secretHex: offer.secretHex,
      broker: offer.broker,
    });
  }, [clearIncoming, sendSignal, joinDmCall]);

  const declineCall = useCallback(() => {
    const offer = incomingRef.current;
    if (!offer) return;
    clearIncoming();
    void sendSignal("decline", offer.author, offer.callId).catch(() => undefined);
  }, [clearIncoming, sendSignal]);

  const acceptRef = useRef(acceptCall);
  acceptRef.current = acceptCall;

  // The one signal subscription: fold every parsed call rumor the DM ingest
  // paths opened (inbox sync, live wrap drain, backfill) into call state.
  useEffect(() => {
    const self = user?.pubkey;
    if (!self) return;
    return subscribeDmCallSignals((signal) => {
      if (signal.author === self) {
        // Our own copy from another device: an answer/decline elsewhere stops
        // this device's ring for the same offer. Own offers/ends are already
        // reflected by this device's own state (or are another device's call).
        const ringing = incomingRef.current;
        if (
          ringing &&
          signal.callId === ringing.callId &&
          (signal.phase === "answer" || signal.phase === "decline")
        ) {
          clearIncoming();
        }
        return;
      }
      switch (signal.phase) {
        case "offer": {
          if (!isDmOfferFresh(signal)) return;
          if (incomingRef.current?.callId === signal.callId) return;
          // Ring only for a KNOWN DM peer (follows ∪ messaged/accepted ∪ pinned,
          // muted excluded). The author controls their own name and avatar, so a
          // cold stranger must not be able to make the phone ring on demand —
          // their offer is dropped silently and their messages still land in the
          // request tier, where contact is on the user's terms.
          if (!knownPeersRef.current.includes(signal.author)) return;
          if (activeCallRef.current) {
            // A known caller reached us mid-call: we can't ring, but they
            // shouldn't vanish. Their ring times out on their side; leave a
            // passive notice here rather than nothing.
            toast({ title: "Missed call", description: "You were already in a call." });
            return;
          }
          const pending = pendingAcceptRef.current;
          setIncoming(signal);
          startIncomingRing();
          if (incomingTimeoutRef.current) clearTimeout(incomingTimeoutRef.current);
          incomingTimeoutRef.current = setTimeout(() => {
            clearIncoming();
          }, Math.max(0, signal.createdAtMs + DM_CALL_RING_MS - Date.now()));
          // An Answer tap on the Android notification deep-linked us here
          // before the offer itself arrived through sync — accept it now.
          if (pending && pending.callId === signal.callId && Date.now() - pending.at < 90_000) {
            pendingAcceptRef.current = null;
            // Let the incoming state land first, then accept it.
            setTimeout(() => acceptRef.current(), 0);
          }
          return;
        }
        case "answer": {
          const out = outgoingRef.current;
          if (out && out.callId === signal.callId && signal.author === out.peer) {
            out.answered = true;
            stopRingback();
          }
          return;
        }
        case "decline": {
          const out = outgoingRef.current;
          if (out && out.callId === signal.callId && signal.author === out.peer) {
            clearOutgoing();
            if (activeCallRef.current?.dm?.callId === signal.callId) leaveCall();
            toast({ title: "Call declined" });
          }
          return;
        }
        case "end": {
          const ringing = incomingRef.current;
          if (ringing && ringing.callId === signal.callId) {
            // The caller hung up before we answered.
            clearIncoming();
            toast({ title: "Missed call" });
          }
          if (activeCallRef.current?.dm?.callId === signal.callId) {
            // The peer left the call; a 1:1 room with one person in it is
            // over, so hang up this side too.
            clearOutgoing();
            leaveCall();
          }
          return;
        }
      }
    });
  }, [user?.pubkey, clearIncoming, clearOutgoing, leaveCall, toast]);

  // The peer arriving in the room is as good as an "answer" rumor.
  useEffect(() => {
    const out = outgoingRef.current;
    if (!out || out.answered || !voiceRoomPubkeys) return;
    if (voiceRoomPubkeys.includes(out.peer)) {
      out.answered = true;
      stopRingback();
    }
  }, [voiceRoomPubkeys]);

  // Leaving a DM call — hangup button, ring timeout, room error — sends "end"
  // so the peer's ring stops (or their side hangs up). Watching the activeCall
  // transition catches every leave path with one seam.
  const prevDmRef = useRef<DmVoiceContext | null>(null);
  useEffect(() => {
    const dm = activeCall?.dm ?? null;
    const prev = prevDmRef.current;
    prevDmRef.current = dm;
    if (prev && (!dm || dm.callId !== prev.callId)) {
      clearOutgoing();
      void sendSignal("end", prev.peer, prev.callId).catch(() => undefined);
    }
  }, [activeCall, sendSignal, clearOutgoing]);

  // Android's incoming-call notification Answer action deep-links
  // `/dm/<peer>?call=<id>`. The URL NAMES a call; it never authorizes one.
  //
  // It used to carry `csecret` and `cbroker` too, and joining on that was the
  // whole authorization — with the only test being that the secret derived the
  // claimed room, which whoever minted the secret satisfies by construction.
  // Everything that reaches the router can produce a URL (a link the user taps,
  // an explicit intent from another app to our exported activity, a crafted
  // notification route), so that was a link away from: dialing an attacker's
  // broker with a bearer grant, decoding
  // their media, showing a call bar naming a pubkey they picked, and publishing
  // a signed NIP-17 "answer" as the user. None of the four gates the ring path
  // applies — freshness, busy, duplicate, followed — ran on it.
  //
  // The offer rode an EPHEMERAL wrap, so a cold-started WebView genuinely
  // cannot re-fetch it. What supplies the parameters instead is the service
  // that posted the ring, through a channel only this app can read
  // (`consumeCallAnswer`) — and it only holds a call it decided to RING, which
  // means fresh, followed, with a well-formed secret and an https broker. So
  // the peer joined is the one the SERVICE verified, not the one the path
  // spells.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const wanted = params.get("call");
    if (!wanted || !/^[0-9a-f]{64}$/.test(wanted)) return;
    // Strip the param first so a later navigation to the same URL (history,
    // a second tap) can't re-answer a call that has already ended.
    navigate(location.pathname, { replace: true });

    // A warm app that already holds the offer needs nothing native: accepting
    // it goes through the same path the on-screen Accept button uses.
    const ringing = incomingRef.current;
    if (ringing && ringing.callId === wanted) {
      acceptRef.current();
      return;
    }

    // Deduped by call id rather than torn down on cleanup: stripping the query
    // above re-runs this effect, and cancelling the in-flight exchange there
    // would drop the very ticket the tap came to collect.
    if (answeringRef.current === wanted) return;
    answeringRef.current = wanted;

    void consumeNativeCallAnswer(wanted).then((ticket) => {
      if (!ticket) return;
      // Busy is checked here as well as on the ring path: a tap can arrive
      // while another call is up, and joining would drop it.
      if (activeCallRef.current) return;
      // Shapes re-checked on this side of the bridge: the peer becomes a `p`
      // tag on an event we are about to seal and publish, and the identity the
      // call bar names.
      if (!/^[0-9a-f]{64}$/.test(ticket.peer)) return;
      if (!/^[0-9a-f]{64}$/.test(ticket.secretHex)) return;
      try {
        // The binding check parseDmCall makes. Kept as an INTEGRITY check on
        // parameters that have already been authorized — never as the
        // authorization itself, which is what having the ticket at all is.
        if (dmCallKeys(ticket.secretHex).room.pk !== wanted) return;
      } catch {
        return;
      }
      // Canonicalized here as `dmCall.ts` already does for an offer's broker:
      // a broker is a bearer-credential endpoint, so plaintext http, userinfo
      // and a path are refused rather than passed through.
      const origin = canonicalOrigin(ticket.broker);
      if (!origin) return;
      clearIncoming();
      pendingAcceptRef.current = null;
      void sendSignal("answer", ticket.peer, wanted).catch(() => undefined);
      joinDmCall({ peer: ticket.peer, callId: wanted, secretHex: ticket.secretHex, broker: origin });
    });

    // No ticket yet: the offer may still be in flight (a tap that raced the
    // relay read), so park it for the signal fold to accept on arrival —
    // which applies the follow gate like any other offer.
    pendingAcceptRef.current = { callId: wanted, at: Date.now() };
  }, [location.search, location.pathname, navigate, clearIncoming, sendSignal, joinDmCall]);

  // Teardown: never leave a loop running past logout/unmount.
  useEffect(
    () => () => {
      stopIncomingRing();
      stopRingback();
      if (ringTimeoutRef.current) clearTimeout(ringTimeoutRef.current);
      if (incomingTimeoutRef.current) clearTimeout(incomingTimeoutRef.current);
    },
    [],
  );

  const value = useMemo<DmCallState>(
    () => ({
      incoming,
      startCall,
      acceptCall,
      declineCall,
      canCall: Boolean(user?.signer.nip44),
    }),
    [incoming, startCall, acceptCall, declineCall, user],
  );

  return (
    <DmCallContext.Provider value={value}>
      {children}
      {incoming && user && (
        <IncomingCallOverlay
          signal={incoming}
          selfPubkey={user.pubkey}
          onAccept={acceptCall}
          onDecline={declineCall}
        />
      )}
    </DmCallContext.Provider>
  );
}

/**
 * The full-screen incoming-call surface: caller identity + Accept / Decline.
 * Rendered above everything (the ring is the most urgent thing on screen) and
 * deliberately modal — a mis-tap answering or declining is recoverable, a
 * buried ring is a missed call.
 */
function IncomingCallOverlay({
  signal,
  selfPubkey,
  onAccept,
  onDecline,
}: {
  signal: DmCallSignal;
  selfPubkey: string;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const author = useAuthor(signal.author);
  const name = getDisplayName(author.data?.metadata, signal.author);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-6 px-8 py-10 clip-corner-lg bg-chrome-deep shadow-xl w-80 max-w-[calc(100vw-2rem)]">
        <DmAvatar peers={[signal.author]} selfPubkey={selfPubkey} sizePx={96} className="size-24" />
        <div className="text-center space-y-1 min-w-0 w-full">
          <div className="text-lg font-semibold truncate">
            <DisplayName pubkey={signal.author} name={name} />
          </div>
          <div className="text-sm text-muted-foreground animate-pulse">Incoming call…</div>
        </div>
        <div className="flex items-center gap-10">
          <div className="flex flex-col items-center gap-1.5">
            <Button
              size="icon"
              aria-label="Decline call"
              className="size-14 rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={onDecline}
            >
              <PhoneOff className="size-6" />
            </Button>
            <span className="text-xs text-muted-foreground">Decline</span>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <Button
              size="icon"
              aria-label="Accept call"
              className="size-14 rounded-full bg-success text-success-foreground hover:bg-success/90"
              onClick={onAccept}
            >
              <Phone className="size-6" />
            </Button>
            <span className="text-xs text-muted-foreground">Accept</span>
          </div>
        </div>
      </div>
    </div>
  );
}
