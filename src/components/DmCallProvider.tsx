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
import { registerBeforeAccountExit } from "@/lib/beforeAccountExit";
import { signerNeedsApproval } from "@/lib/bulkDecryptGate";
import { consumeNativeCallAnswer, setNativeCallPeer } from "@/lib/nativeNotifications";
import {
  startIncomingRing,
  startRingback,
  stopIncomingRing,
  stopRingback,
} from "@/lib/callSounds";
import {
  DM_CALL_COLLISION_FALLBACK_MS,
  DM_CALL_RING_MS,
  deliverDmCallRumors,
  dmCallCollisionWinner,
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
 *     messages in the request tier. A known caller is sent a "ringing"
 *     receipt, or "busy" (plus a passive "Missed call" notice here) when this
 *     device is already in a DM call. Muting a peer silences their calls like
 *     everything else.
 *   - RECEIPTS are signed without the user doing anything, so they are sent
 *     only by a login that signs silently (an nsec — never a NIP-07 extension
 *     or NIP-46 bunker, which may prompt per signature), at most one per call
 *     id, and at most one per peer per {@link RECEIPT_PEER_INTERVAL_MS}.
 *   - BUSY is sent only from a DM call. Being in a Concord voice channel is
 *     not "busy": the offer goes unanswered here (a passive notice) and the
 *     user's other devices keep ringing, where a "busy" would have ended the
 *     caller's attempt for all of them.
 *   - COLLISIONS: two people dialing each other at once settle on one call
 *     (`dmCallCollisionWinner`) — the losing side joins the winning room and
 *     answers it instead of each ringing into an empty room of their own. The
 *     winner tells its OTHER devices (a self-only "answer" for the losing call
 *     id) so they stop ringing for it without a missed call, ignores the
 *     losing offer if it lands late, and — if neither an answer nor a ringing
 *     receipt for ours arrives within {@link DM_CALL_COLLISION_FALLBACK_MS} of
 *     our offer going out (it was lost, or the loser predates collision
 *     handling) — joins the losing call instead, while it is still fresh. A
 *     sibling device that sees our own offer go out does not ring for the same
 *     peer's offer either: the device that dialed owns the collision.
 *   - CALLER FEEDBACK: a "busy" receipt ends the attempt at once; at the ring
 *     timeout, a "ringing" receipt makes it "No answer", and none at all says
 *     it may not have rung, and why that can happen (receipts are best-effort
 *     and older clients send none, so it is never stated as fact).
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
/** Minimum gap between two receipts to one peer, so a burst of offers can't farm signatures. */
const RECEIPT_PEER_INTERVAL_MS = 3_000;
/** Call ids remembered for receipt dedupe; older ones fall out first. */
const RECEIPT_MEMORY = 256;
/** How often a live DM call re-reports its peer to the Android service. */
const CALL_PEER_HEARTBEAT_MS = 20_000;
/** sessionStorage key for the call ids this tab minted (room names, not secrets). */
const OWN_CALL_IDS_KEY = "armada:dm-call-own-ids";
/** Own call ids kept across a reload — only the last ring window's matter. */
const OWN_CALL_IDS_MEMORY = 32;

function readOwnCallIds(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(OWN_CALL_IDS_KEY) ?? "[]");
    return new Set(
      Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [],
    );
  } catch {
    return new Set();
  }
}

function rememberOwnCallId(ids: Set<string>, callId: string): void {
  ids.add(callId);
  while (ids.size > OWN_CALL_IDS_MEMORY) ids.delete(ids.values().next().value!);
  try {
    sessionStorage.setItem(OWN_CALL_IDS_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage unavailable: this session still knows; only a reload forgets.
  }
}

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
  /**
   * The outgoing attempt, from the moment its call id is minted — BEFORE the
   * offer is out, so a peer dialing us in that window is recognised as the
   * same attempt rather than rung as a second call. Cleared once it ends.
   * `reached`: a device of the peer's reported ringing (or answered), which is
   * what separates "nobody picked up" from "it never rang anywhere".
   * `collided`: the peer's own offer, dropped because ours won the tie-break —
   * held so the collision fallback can still join it.
   * `sent`: our offer reached a relay, which is when the fallback clock starts.
   */
  const outgoingRef = useRef<
    {
      callId: string;
      peer: string;
      answered: boolean;
      reached: boolean;
      sent: boolean;
      collided?: DmCallSignal;
    } | null
  >(null);
  const ringTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collisionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The peer this device is dialing (before a room is up), for the Android service. */
  const [dialingPeer, setDialingPeer] = useState<string | null>(null);
  /**
   * Call ids this device minted, so our own offer's self copy isn't read as a
   * sibling's. Seeded from the tab's session so a reload doesn't mistake a
   * late copy of the offer it placed just before for another device dialing.
   */
  const ownCallIdsRef = useRef<Set<string> | null>(null);
  ownCallIdsRef.current ??= readOwnCallIds();
  /** Colliding offers already dismissed on our other devices, by call id. */
  const dismissedCallIdsRef = useRef(new Set<string>());
  const dismissedAtRef = useRef(new Map<string, number>());
  /**
   * An offer ANOTHER device of ours just placed (seen as its self copy): that
   * device owns any collision with the same peer, so this one doesn't ring.
   */
  const siblingDialRef = useRef<{ peer: string; callId: string; createdAtMs: number } | null>(null);
  const receiptCallIdsRef = useRef(new Set<string>());
  const receiptAtRef = useRef(new Map<string, number>());
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
  const userRef = useRef(user);
  userRef.current = user;
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
   * Receipts ("ringing"/"busy") are for the caller alone and skip the self
   * copy; `selfOnly` is the reverse, telling our other devices without the peer
   * (the winner of a collision dismissing their ring for the losing call).
   * Resolves true when at least one relay accepted the peer's copy.
   */
  const sendSignal = useCallback(
    async (
      phase: DmCallPhase,
      peer: string,
      callId: string,
      extras?: { secretHex?: string; broker?: string; selfOnly?: boolean },
    ): Promise<boolean> => {
      const selfCopy = phase !== "ringing" && phase !== "busy";
      if (!user?.signer.nip44) return false;
      const signer = user.signer as unknown as Dm17Signer;
      const rumor = buildDmRumor({
        kind: KIND_DM_CALL,
        content: phase,
        tags: dmCallTags(peer, callId, extras),
        pubkey: user.pubkey,
      });
      let delivered = true;
      if (!extras?.selfOnly) {
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
        delivered = results.some((r) => r.status === "fulfilled");
      }
      // Self copy is best-effort and never gates the send result. It goes to our
      // SCAN set (stock floor included) so a sibling device listening there hears
      // it. "answer"/"decline" are the signals that STOP another device's ring,
      // and a single ephemeral broadcast is lost if that device's socket blips —
      // so re-send those a couple of times over the next few seconds. The wrap is
      // re-broadcast verbatim, so a sibling that already folded it dedupes the
      // retries by rumor id; one that missed the first send now catches up.
      if (selfCopy) void (async () => {
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
      return delivered;
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
    if (collisionTimerRef.current) {
      clearTimeout(collisionTimerRef.current);
      collisionTimerRef.current = null;
    }
    stopRingback();
    outgoingRef.current = null;
    setDialingPeer(null);
  }, []);

  /**
   * End our attempt in favour of the peer's colliding offer, when we hold one
   * that is still live. True when it did — the caller then has nothing to
   * report, because the two of them are about to be connected.
   */
  const yieldToCollided = useCallback((): boolean => {
    const theirs = outgoingRef.current?.collided;
    if (!theirs || !isDmOfferFresh(theirs)) return false;
    clearOutgoing();
    joinOfferRef.current(theirs);
    return true;
  }, [clearOutgoing]);

  /**
   * Start the collision fallback clock for the attempt `callId`, once BOTH our
   * offer is delivered and the peer's losing offer is in hand. Counting from
   * the loser's offer instead would start it while ours may still be waiting on
   * a broker probe or a signature, and the loser could then land in our room
   * just as we left it for theirs — each side's "end" hanging up the other.
   * Any sign the loser has our offer (an answer, a ringing receipt, arriving in
   * our room) settles it for our call, as does the loser withdrawing its own.
   */
  const armCollisionFallback = useCallback(
    (callId: string) => {
      const out = outgoingRef.current;
      if (!out || out.callId !== callId || !out.sent || !out.collided) return;
      if (collisionTimerRef.current) return;
      collisionTimerRef.current = setTimeout(() => {
        collisionTimerRef.current = null;
        const now = outgoingRef.current;
        if (!now || now.callId !== callId || now.answered || now.reached) return;
        yieldToCollided();
      }, DM_CALL_COLLISION_FALLBACK_MS);
    },
    [yieldToCollided],
  );

  const cancelCollisionFallback = useCallback(() => {
    if (collisionTimerRef.current) {
      clearTimeout(collisionTimerRef.current);
      collisionTimerRef.current = null;
    }
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
      // The peer is ringing US: calling them back is answering that call, not
      // placing a second one they would only see as busy.
      if (incomingRef.current?.author === peer) {
        acceptRef.current();
        return;
      }
      if (activeCallRef.current) {
        toast({ title: "Already in a call", description: "Leave the current call first." });
        return;
      }
      if (outgoingRef.current) return;
      const { secretHex, callId } = mintDmCall();
      outgoingRef.current = { callId, peer, answered: false, reached: false, sent: false };
      rememberOwnCallId(ownCallIdsRef.current!, callId);
      setDialingPeer(peer);
      // False once the attempt has been dropped under us — the peer's own call
      // won a collision while we were still resolving a broker or sending.
      const stillOurs = () => outgoingRef.current?.callId === callId;
      // Resolve a reachable blind broker from our own defaults (the offer
      // carries the winner as the rendezvous hint, like Concord presence).
      let broker: string | null = null;
      for (const origin of ownAvServers()) {
        if (await probeAvBroker(origin)) {
          broker = origin;
          break;
        }
      }
      if (!stillOurs()) return;
      if (!broker) {
        if (yieldToCollided()) return;
        clearOutgoing();
        toast({
          title: "Could not start the call",
          description: "No voice server is reachable.",
          variant: "destructive",
        });
        return;
      }
      const sent = await sendSignal("offer", peer, callId, { secretHex, broker }).catch(() => false);
      if (!stillOurs()) {
        // The offer may have gone out before the collision was settled; the
        // peer ignores it either way, but withdraw it rather than leave it live.
        if (sent) void sendSignal("end", peer, callId).catch(() => undefined);
        return;
      }
      if (!sent) {
        // Our offer reached no relay, so the peer can't be answering it; if
        // theirs is in hand, that is the call.
        if (yieldToCollided()) return;
        clearOutgoing();
        toast({
          title: "Could not start the call",
          description: "The call invite could not be delivered to any relay.",
          variant: "destructive",
        });
        return;
      }
      outgoingRef.current!.sent = true;
      // A losing offer that landed while ours was still going out has waited
      // for this: only now can the loser be answering ours.
      armCollisionFallback(callId);
      const ctx: DmVoiceContext = { peer, callId, secretHex, broker };
      joinDmCall(ctx);
      startRingback();
      ringTimeoutRef.current = setTimeout(() => {
        const out = outgoingRef.current;
        if (!out || out.callId !== callId || out.answered) return;
        // Nobody picked up: end our side; the leave effect below sends "end"
        // so the peer's (possibly still undelivered) ring stops too.
        clearOutgoing();
        leaveCall();
        if (out.reached) {
          toast({ title: "No answer" });
        } else {
          // No device of theirs said it rang. It may be offline, it may
          // predate (or not send) the "ringing" receipt — so it may well have
          // rung — or its ring gate refused us, which is silent by design.
          toast({
            title: "No answer",
            description:
              "The call may not have rung for them. Calls only ring for people who follow you or have messaged you, and only while Armada is running for them.",
          });
        }
      }, DM_CALL_RING_MS);
    },
    [user, toast, sendSignal, joinDmCall, leaveCall, clearOutgoing, yieldToCollided, armCollisionFallback],
  );

  /** Take an offer: tell the caller (and our other devices), then join its room. */
  const joinOffer = useCallback(
    (offer: DmCallSignal) => {
      if (!offer.secretHex || !offer.broker) return;
      // Fire-and-forget: the answer stops the caller's ringback and our other
      // devices' ringing; joining the room is what actually connects the call.
      void sendSignal("answer", offer.author, offer.callId).catch(() => undefined);
      joinDmCall({
        peer: offer.author,
        callId: offer.callId,
        secretHex: offer.secretHex,
        broker: offer.broker,
      });
    },
    [sendSignal, joinDmCall],
  );
  const joinOfferRef = useRef(joinOffer);
  joinOfferRef.current = joinOffer;
  const sendSignalRef = useRef(sendSignal);
  sendSignalRef.current = sendSignal;

  const acceptCall = useCallback(() => {
    const offer = incomingRef.current;
    if (!offer?.secretHex || !offer.broker) return;
    clearIncoming();
    joinOffer(offer);
  }, [clearIncoming, joinOffer]);

  const declineCall = useCallback(() => {
    const offer = incomingRef.current;
    if (!offer) return;
    clearIncoming();
    void sendSignal("decline", offer.author, offer.callId).catch(() => undefined);
  }, [clearIncoming, sendSignal]);

  const acceptRef = useRef(acceptCall);
  acceptRef.current = acceptCall;

  /**
   * Send a "ringing"/"busy" receipt, if this login may sign one unprompted.
   * Receipts are signed without any user action, so a signer that can prompt
   * per signature (NIP-07 extension, NIP-46 bunker) sends none — a caller
   * would otherwise be able to pop approval dialogs on demand. Even with a
   * local key, at most one per call id and one per peer per interval.
   */
  const sendReceipt = useCallback((phase: "ringing" | "busy", peer: string, callId: string) => {
    if (signerNeedsApproval(userRef.current?.method)) return;
    const sentIds = receiptCallIdsRef.current;
    if (sentIds.has(callId)) return;
    const now = Date.now();
    const last = receiptAtRef.current.get(peer);
    if (last !== undefined && now - last < RECEIPT_PEER_INTERVAL_MS) return;
    sentIds.add(callId);
    if (sentIds.size > RECEIPT_MEMORY) sentIds.delete(sentIds.values().next().value!);
    receiptAtRef.current.set(peer, now);
    void sendSignalRef.current(phase, peer, callId).catch(() => undefined);
  }, []);

  /**
   * A colliding offer this device dropped: tell our OTHER devices, which may
   * be ringing for it, that it is settled — a self-only "answer", the same
   * signal that stops their ring when the call is answered here, so they go
   * quiet without a "Missed call". The peer gets nothing: they are joining (or
   * already in) our call.
   *
   * Triggered by the PEER's offer, so it is gated exactly like a receipt: a
   * signer that may prompt sends none (our other devices already stay quiet
   * for a peer they saw this one dial), and at most one per call id and one
   * per peer per interval, so a burst of offers can't farm signatures.
   */
  const dismissOnSiblings = useCallback((offer: DmCallSignal) => {
    if (signerNeedsApproval(userRef.current?.method)) return;
    const ids = dismissedCallIdsRef.current;
    if (ids.has(offer.callId)) return;
    const now = Date.now();
    const last = dismissedAtRef.current.get(offer.author);
    if (last !== undefined && now - last < RECEIPT_PEER_INTERVAL_MS) return;
    ids.add(offer.callId);
    if (ids.size > RECEIPT_MEMORY) ids.delete(ids.values().next().value!);
    dismissedAtRef.current.set(offer.author, now);
    void sendSignalRef.current("answer", offer.author, offer.callId, { selfOnly: true }).catch(
      () => undefined,
    );
  }, []);

  // The one signal subscription: fold every parsed call rumor the DM ingest
  // paths opened (inbox sync, live wrap drain, backfill) into call state.
  useEffect(() => {
    const self = user?.pubkey;
    if (!self) return;
    return subscribeDmCallSignals((signal) => {
      if (signal.author === self) {
        // Our own copy from another device: an answer/decline elsewhere stops
        // this device's ring for the same offer. Own offers/ends are already
        // reflected by this device's own state (or are another device's call)
        // — except that a sibling's offer means that device owns any collision
        // with the same peer, so this one must not ring for their offer.
        if (!ownCallIdsRef.current!.has(signal.callId)) {
          if (signal.phase === "offer" && isDmOfferFresh(signal)) {
            // Bounded by the offer's OWN ring window, not by when it reached
            // us: a late copy suppresses nothing past the point it could ring.
            siblingDialRef.current = {
              peer: signal.peer,
              callId: signal.callId,
              createdAtMs: signal.createdAtMs,
            };
            const ringingNow = incomingRef.current;
            if (ringingNow && ringingNow.author === signal.peer) clearIncoming();
          } else if (signal.phase === "end" && siblingDialRef.current?.callId === signal.callId) {
            siblingDialRef.current = null;
          }
        }
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
          const out = outgoingRef.current;
          if (out && out.peer === signal.author && !out.answered) {
            // We are dialing each other. Without this both sides sit in their
            // own room, each treating the other's offer as a call-while-busy.
            // Both apply the same tie-break, so exactly one call survives: the
            // loser joins it and answers, the winner waits for that answer.
            // Ahead of the ring gate on purpose — dialing them is consent.
            if (dmCallCollisionWinner(self, signal.author) === "ours") {
              dismissOnSiblings(signal);
              // Held for the fallback: if the loser never answers ours (our
              // offer was lost, or it predates collision handling and is
              // ringing out in its own room), join theirs instead. The clock
              // starts once ours is out — now, or when startCall delivers it.
              if (!out.collided) {
                out.collided = signal;
                armCollisionFallback(out.callId);
              }
              return;
            }
            // We lost: always yield to the winner's room, which the winner
            // holds for the full fallback window after its offer goes out.
            clearOutgoing();
            joinOfferRef.current(signal);
            return;
          }
          // The other half of a call we already own with this peer: a losing
          // offer landing after the loser answered ours, or after we connected.
          // It is glare, not a second caller — no busy, no missed call.
          if (out?.peer === signal.author || activeCallRef.current?.dm?.peer === signal.author) {
            dismissOnSiblings(signal);
            return;
          }
          // Another device of ours is dialing this peer right now: it owns the
          // collision, and ringing here would only end in a false missed call.
          const sibling = siblingDialRef.current;
          if (
            sibling &&
            sibling.peer === signal.author &&
            Date.now() - sibling.createdAtMs <= DM_CALL_RING_MS
          ) {
            return;
          }
          // Ring only for a KNOWN DM peer (follows ∪ messaged/accepted ∪ pinned,
          // muted excluded). The author controls their own name and avatar, so a
          // cold stranger must not be able to make the phone ring on demand —
          // their offer is dropped silently, with no receipt either, and their
          // messages still land in the request tier, where contact is on the
          // user's terms.
          if (!knownPeersRef.current.includes(signal.author)) return;
          if (activeCallRef.current) {
            // A known caller reached us mid-call: we can't ring, but they
            // shouldn't vanish. From a DM call, tell them we're busy so their
            // attempt ends now rather than at the ring timeout. A voice
            // CHANNEL is not busy: a "busy" would end the attempt for every
            // device of ours, and the others are free to ring.
            if (activeCallRef.current.dm) {
              sendReceipt("busy", signal.author, signal.callId);
              toast({ title: "Missed call", description: "You were already in a call." });
            } else {
              toast({ title: "Missed call", description: "You were in a voice channel." });
            }
            return;
          }
          const pending = pendingAcceptRef.current;
          setIncoming(signal);
          startIncomingRing();
          sendReceipt("ringing", signal.author, signal.callId);
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
            out.reached = true;
            cancelCollisionFallback();
            stopRingback();
          }
          return;
        }
        case "ringing": {
          const out = outgoingRef.current;
          if (out && out.callId === signal.callId && signal.author === out.peer) {
            out.reached = true;
            // Our offer reached them and is ringing there — someone may yet
            // pick it up, so it is no longer ours to abandon for theirs.
            cancelCollisionFallback();
          }
          return;
        }
        case "busy": {
          const out = outgoingRef.current;
          if (out && out.callId === signal.callId && signal.author === out.peer && !out.answered) {
            clearOutgoing();
            if (activeCallRef.current?.dm?.callId === signal.callId) leaveCall();
            toast({ title: "On another call", description: "They're already in a call. Try again later." });
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
          // The loser of a collision withdrawing its offer: it is joining ours,
          // so there is nothing left for the fallback to join.
          const pending = outgoingRef.current;
          if (pending?.collided?.callId === signal.callId && signal.author === pending.peer) {
            pending.collided = undefined;
            cancelCollisionFallback();
          }
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
  }, [
    user?.pubkey,
    clearIncoming,
    clearOutgoing,
    leaveCall,
    toast,
    sendReceipt,
    dismissOnSiblings,
    armCollisionFallback,
    cancelCollisionFallback,
  ]);

  // The peer arriving in the room is as good as an "answer" rumor.
  useEffect(() => {
    const out = outgoingRef.current;
    if (!out || out.answered || !voiceRoomPubkeys) return;
    if (voiceRoomPubkeys.includes(out.peer)) {
      out.answered = true;
      cancelCollisionFallback();
      stopRingback();
    }
  }, [voiceRoomPubkeys, cancelCollisionFallback]);

  // The Android service rings from its own sockets and knows nothing of this
  // WebView's calls, so it is told which peer we are dialing or talking to: it
  // then neither rings for nor posts a missed call about that peer's offers —
  // the other half of a collision. Heartbeat-bound on the native side, so a
  // WebView that dies without clearing it can't silence that peer for long.
  const callPeer = activeCall?.dm?.peer ?? dialingPeer;
  useEffect(() => {
    setNativeCallPeer(callPeer);
    if (!callPeer) return;
    const beat = setInterval(() => setNativeCallPeer(callPeer), CALL_PEER_HEARTBEAT_MS);
    // Logout and account switch navigate away without running this cleanup,
    // which would leave the service muting this peer until the heartbeat lapses.
    const unregisterExit = registerBeforeAccountExit(async () => {
      clearInterval(beat);
      setNativeCallPeer(null);
    });
    return () => {
      unregisterExit();
      clearInterval(beat);
      setNativeCallPeer(null);
    };
  }, [callPeer]);

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
  // applies — freshness, busy, duplicate, known peer — ran on it.
  //
  // The offer rode an EPHEMERAL wrap, so a cold-started WebView genuinely
  // cannot re-fetch it. What supplies the parameters instead is the service
  // that posted the ring, through a channel only this app can read
  // (`consumeCallAnswer`) — and it only holds a call it decided to RING, which
  // means fresh, from a known peer, with a well-formed secret and an https
  // broker. So the peer joined is the one the SERVICE verified, not the one the
  // path spells.
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
    // which applies the ring gate like any other offer.
    pendingAcceptRef.current = { callId: wanted, at: Date.now() };
  }, [location.search, location.pathname, navigate, clearIncoming, sendSignal, joinDmCall]);

  // Teardown: never leave a loop running past logout/unmount.
  useEffect(
    () => () => {
      stopIncomingRing();
      stopRingback();
      if (ringTimeoutRef.current) clearTimeout(ringTimeoutRef.current);
      if (collisionTimerRef.current) clearTimeout(collisionTimerRef.current);
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
