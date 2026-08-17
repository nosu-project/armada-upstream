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
import { useFollowList } from "@/hooks/useFollowList";
import { useToast } from "@/hooks/useToast";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { DmCallContext, type DmCallState } from "@/contexts/DmCallContext";
import { recipientInboxRelays } from "@/concord/lib/inviteRelays";
import { ownAvServers } from "@/concord/hooks/useVoice";
import { probeAvBroker } from "@/concord/lib/voice";
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
 *   - INCOMING: a fresh offer from a FOLLOWED peer rings a full-screen
 *     overlay (Accept / Decline) with a looping ringtone. Following is the
 *     gate on purpose: the offer's author controls their name and avatar, and
 *     a stranger must not be able to make a phone ring on demand. Non-followed
 *     offers are ignored; the conversation itself still shows their messages.
 *   - The signal fold: "answer" stops the caller's ringback (and, as an own
 *     self-copy, other devices' ringing); "decline" ends the caller's attempt;
 *     "end" is both cancel-while-ringing and hangup — while connected to that
 *     call it hangs up this side too, which is what makes a 1:1 call END when
 *     either party leaves rather than stranding one person in an empty room.
 *
 * Mounted inside CallProvider (it drives joinDmCall/leaveCall) and inside the
 * router (the Android incoming-call notification's Answer action deep-links
 * `/dm/<peer>?call=<id>`, which auto-accepts the matching offer on arrival).
 */
export function DmCallProvider({ children }: { children: React.ReactNode }) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { relays: publishedRelays } = useDmRelayList();
  const { data: followData } = useFollowList();
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

  // Live refs so the signal listener (one subscription for the provider's
  // lifetime) always reads current state without re-subscribing.
  const incomingRef = useRef(incoming);
  incomingRef.current = incoming;
  const activeCallRef = useRef(activeCall);
  activeCallRef.current = activeCall;
  const followsRef = useRef<readonly string[]>([]);
  followsRef.current = followData?.pubkeys ?? [];

  // Where our copies publish and our other sessions read: the same union the
  // DM inbox sync and typing indicators use.
  const myRelays = useMemo(
    () => [...new Set([...effectiveDmRelays(config), ...publishedRelays])],
    [config, publishedRelays],
  );
  const myRelaysRef = useRef(myRelays);
  myRelaysRef.current = myRelays;

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
   * copy to their published inbox (or NIP-65 reads) ∪ our DM relays, and a
   * best-effort self copy so our other devices fold the same call state
   * (answered/declined elsewhere). Relays broadcast and store nothing.
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
      const inbox = await recipientInboxRelays(nostr, peer).catch(() => null);
      const targets = [...new Set([...(inbox ?? []), ...myRelaysRef.current])];
      if (targets.length === 0) return false;
      const wrap = wrapDmSealEphemeral(await sealDmRumor(rumor, peer, signer), peer);
      const results = await Promise.allSettled(
        targets.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
      );
      // Self copy is best-effort and never gates the send result.
      void (async () => {
        try {
          const selfWrap = wrapDmSealEphemeral(
            await sealDmRumor(rumor, user.pubkey, signer),
            user.pubkey,
          );
          await Promise.allSettled(
            myRelaysRef.current.map((url) =>
              nostr.relay(url).event(selfWrap, { signal: AbortSignal.timeout(8000) }),
            ),
          );
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
  const myRelaysKey = myRelays.join(",");
  useEffect(() => {
    const self = user?.pubkey;
    if (!self || !user?.signer.nip44 || myRelays.length === 0) return;
    const controller = new AbortController();
    const signer = user.signer as unknown as Dm17Signer;
    for (const url of myRelays) {
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
  }, [nostr, user?.pubkey, myRelaysKey]);

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
          if (activeCallRef.current) return; // busy: their ring times out
          if (incomingRef.current?.callId === signal.callId) return;
          // Ring only for people the user follows. The author controls their
          // own name and avatar, so a stranger must not be able to make the
          // phone ring on demand — their messages still land in the request
          // tier, where contact is on the user's terms.
          if (!followsRef.current.includes(signal.author)) return;
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
  // `/dm/<peer>?call=<id>&csecret=<hex>&cbroker=<origin>`. The offer rode an
  // EPHEMERAL wrap, so a cold-started WebView can never re-fetch it — the
  // service passes the call parameters through the app-internal intent
  // instead (PendingIntent to our own activity; nothing leaves the process).
  // With all three present the call is joined directly; with only `call`
  // (a warm app whose provider already holds — or is about to receive — the
  // offer) the matching in-hand offer is accepted.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const wanted = params.get("call");
    if (!wanted || !/^[0-9a-f]{64}$/.test(wanted)) return;
    const secret = params.get("csecret");
    const broker = params.get("cbroker");
    // Strip the params first so a later navigation to the same URL (history,
    // a second tap) can't re-answer a call that has already ended.
    navigate(location.pathname, { replace: true });
    const peerParam = /^\/dm\/([0-9a-f]{64})(?:[/,]|$)/.exec(location.pathname)?.[1];
    if (secret && broker && peerParam && /^[0-9a-f]{64}$/.test(secret)) {
      try {
        // The same binding check parseDmCall makes: the secret must derive
        // the claimed room, or the parameters are garbage.
        if (dmCallKeys(secret).room.pk !== wanted) return;
      } catch {
        return;
      }
      clearIncoming();
      void sendSignal("answer", peerParam, wanted).catch(() => undefined);
      joinDmCall({ peer: peerParam, callId: wanted, secretHex: secret, broker });
      return;
    }
    const ringing = incomingRef.current;
    if (ringing && ringing.callId === wanted) {
      acceptRef.current();
    } else {
      pendingAcceptRef.current = { callId: wanted, at: Date.now() };
    }
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
