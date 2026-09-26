import { act, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DmCallProvider } from "./DmCallProvider";
import { useDmCall, type DmCallState } from "@/contexts/DmCallContext";
import {
  _resetDmCallBusForTests,
  DM_CALL_COLLISION_FALLBACK_MS,
  DM_CALL_RING_MS,
  deliverDmCallRumors,
  dmCallTags,
  mintDmCall,
} from "@/lib/dmCall";
import { startIncomingRing } from "@/lib/callSounds";
import { consumeNativeCallAnswer } from "@/lib/nativeNotifications";
import { KIND_DM_CALL, type OpenedDm } from "@/lib/nip17/protocol";

/**
 * The Answer deep link is a NAME, not an authorization.
 *
 * `/dm/<peer>?call=<id>` once carried `csecret` and `cbroker` too, and joining
 * on them was the whole decision — the only test being that the secret derived
 * the claimed room, which whoever minted the secret satisfies by construction.
 * Anything that reaches the router can produce a URL, so a link was enough to
 * make the client dial an attacker's broker, decode their media, show a call
 * bar naming a pubkey they chose, and publish a signed NIP-17 "answer" as the
 * user — with none of the four gates the ring path applies.
 *
 * These pin the replacement: the parameters come from the background service
 * that vetted the offer before it rang, through a channel only this app can
 * read, and the peer joined is the one IT verified rather than the one the path
 * spells.
 */

const self = "a".repeat(64);
/** The pubkey the attacker puts in the path — a contact of the victim's. */
const pathPeer = "b".repeat(64);
/** The peer the service actually saw the offer from. */
const realPeer = "c".repeat(64);

const joinDmCall = vi.fn();
const publish = vi.fn().mockResolvedValue(undefined);
const leaveCall = vi.fn();

// A relay that accepts every event and never delivers anything: the tests feed
// signals straight into the bus, and read what was sent off `publish`.
const relay = {
  event: (...args: unknown[]) => publish(...args),
  // eslint-disable-next-line require-yield
  req: async function* () {},
};
vi.mock("@nostrify/react", () => ({
  useNostr: () => ({ nostr: { group: () => relay, relay: () => relay, event: publish } }),
}));
// A local key signs receipts silently; a test flips this to a prompting signer.
const login = vi.hoisted(() => ({ method: "nsec" }));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({
    user: {
      pubkey: self,
      method: login.method,
      signer: { nip44: { encrypt: async () => "", decrypt: async () => "" } },
    },
  }),
}));
// Empty by default, which leaves the provider no relays at all — the deep-link
// tests rely on that to show nothing is published. The signaling tests give it
// one DM relay so a signal has somewhere to go.
const app = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));
vi.mock("@/hooks/useAppContext", () => ({ useAppContext: () => ({ config: app.config }) }));
vi.mock("@/concord/lib/inviteRelays", () => ({
  recipientInboxRelays: async () => ["wss://inbox.example"],
  inviteDeliveryRelays: (inbox: string[]) => inbox,
}));
vi.mock("@/concord/hooks/useVoice", () => ({ ownAvServers: () => ["https://broker.example"] }));
const probe = vi.hoisted(() => ({ fn: vi.fn(async (_origin: string) => true) }));
vi.mock("@/concord/lib/voice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/concord/lib/voice")>()),
  probeAvBroker: (origin: string) => probe.fn(origin),
}));
// Sealing is replaced by a transparent envelope so a test can read back which
// rumor went to whom: the "wrap" handed to the relay IS { rumor, recipient }.
vi.mock("@/lib/nip17/protocol", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/nip17/protocol")>()),
  sealDmRumor: async (rumor: unknown, recipient: string) => ({ rumor, recipient }),
  wrapDmSealEphemeral: (seal: unknown) => seal,
}));
vi.mock("@/hooks/useDmRelayList", () => ({ useDmRelayList: () => ({ relays: [] }) }));
// The known-peer set the ring gate reads. Mutable so a test can make a caller
// known or a stranger. Empty by default: the deep-link tests below need the ring
// path to refuse the offer outright, which is exactly what the URL path skipped.
const known = vi.hoisted(() => ({ peers: [] as string[] }));
const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/useKnownDmPeers", () => ({ useKnownDmPeers: () => ({ knownPeers: known.peers }) }));
vi.mock("@/hooks/useVoiceActivity", () => ({ useVoiceActivity: () => ({ voiceRoomPubkeys: [] }) }));
vi.mock("@/hooks/useToast", () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock("@/lib/callSounds", () => ({
  startIncomingRing: vi.fn(),
  startRingback: vi.fn(),
  stopIncomingRing: vi.fn(),
  stopRingback: vi.fn(),
}));
vi.mock("@/lib/nativeNotifications", () => ({
  consumeNativeCallAnswer: vi.fn(),
  setNativeCallPeer: vi.fn(),
}));
// The incoming-call overlay's identity surface pulls TanStack Query / the event
// store; stub it so a ringing test doesn't need those providers.
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/components/DmAvatar", () => ({ DmAvatar: () => null }));
vi.mock("@/components/DisplayName", () => ({ DisplayName: () => null }));

const activeCall: { current: unknown } = { current: null };
vi.mock("@/hooks/useCall", () => ({
  useCall: () => ({ activeCall: activeCall.current, joinDmCall, leaveCall }),
}));

const consume = vi.mocked(consumeNativeCallAnswer);

/** A real secret/room pair, so the integrity check is exercised, not stubbed. */
const { secretHex, callId } = mintDmCall();
const broker = "https://broker.example";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <DmCallProvider>{null}</DmCallProvider>
    </MemoryRouter>,
  );
}

/** Let the consume promise settle and any resulting state land. */
async function settle() {
  await waitFor(() => expect(consume).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
}

describe("DmCallProvider Answer deep link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeCall.current = null;
    known.peers = [];
    consume.mockResolvedValue(null);
  });

  it("does not join a call the service never rang", async () => {
    // The whole attack: a URL alone, with no offer in hand and no ticket —
    // which is also what every non-Android platform answers.
    renderAt(`/dm/${pathPeer}?call=${callId}`);
    await settle();
    expect(joinDmCall).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("asks the service about the call the URL names, and nothing else", async () => {
    renderAt(`/dm/${pathPeer}?call=${callId}`);
    await settle();
    expect(consume).toHaveBeenCalledWith(callId);
  });

  it("ignores a call id that is not a room id", async () => {
    renderAt(`/dm/${pathPeer}?call=not-hex`);
    await new Promise((r) => setTimeout(r, 0));
    expect(consume).not.toHaveBeenCalled();
    expect(joinDmCall).not.toHaveBeenCalled();
  });

  it("joins the peer the service verified, not the one in the path", async () => {
    // The positive control — the Android Answer action keeps working — and the
    // identity-spoofing fix in one: the path names `pathPeer`, the ticket names
    // `realPeer`, and the call bar must name the latter.
    consume.mockResolvedValue({ peer: realPeer, secretHex, broker });
    renderAt(`/dm/${pathPeer}?call=${callId}`);
    await waitFor(() => expect(joinDmCall).toHaveBeenCalledTimes(1));
    expect(joinDmCall).toHaveBeenCalledWith({
      peer: realPeer,
      callId,
      secretHex,
      broker,
    });
  });

  it("refuses a ticket whose secret does not derive the call", async () => {
    // The integrity check survives as a check — it is no longer the decision.
    const other = mintDmCall();
    consume.mockResolvedValue({ peer: realPeer, secretHex: other.secretHex, broker });
    renderAt(`/dm/${pathPeer}?call=${callId}`);
    await settle();
    expect(joinDmCall).not.toHaveBeenCalled();
  });

  it("refuses a secret that is not 32 bytes of hex", async () => {
    consume.mockResolvedValue({ peer: realPeer, secretHex: "nope", broker });
    renderAt(`/dm/${pathPeer}?call=${callId}`);
    await settle();
    expect(joinDmCall).not.toHaveBeenCalled();
  });

  it("refuses a peer that is not a pubkey", async () => {
    // It would become a `p` tag on an event we seal and publish.
    consume.mockResolvedValue({ peer: "not-a-pubkey", secretHex, broker });
    renderAt(`/dm/${pathPeer}?call=${callId}`);
    await settle();
    expect(joinDmCall).not.toHaveBeenCalled();
  });

  it.each([
    ["plaintext http", "http://broker.example"],
    ["userinfo", "https://user:pw@broker.example"],
    ["not a URL", "broker.example"],
  ])("refuses a %s broker origin", async (_label, bad) => {
    consume.mockResolvedValue({ peer: realPeer, secretHex, broker: bad });
    renderAt(`/dm/${pathPeer}?call=${callId}`);
    await settle();
    expect(joinDmCall).not.toHaveBeenCalled();
  });

  it("normalizes a broker carrying a path down to its origin", async () => {
    consume.mockResolvedValue({ peer: realPeer, secretHex, broker: "https://Broker.Example/rtc" });
    renderAt(`/dm/${pathPeer}?call=${callId}`);
    await waitFor(() => expect(joinDmCall).toHaveBeenCalledTimes(1));
    expect(joinDmCall.mock.calls[0][0].broker).toBe("https://broker.example");
  });

  it("is inert while another call is up", async () => {
    activeCall.current = { dm: { callId: "d".repeat(64), peer: realPeer } };
    consume.mockResolvedValue({ peer: realPeer, secretHex, broker });
    renderAt(`/dm/${pathPeer}?call=${callId}`);
    await settle();
    expect(joinDmCall).not.toHaveBeenCalled();
  });
});

/**
 * The ring gate: an incoming offer rings only for a KNOWN DM peer (the
 * `useKnownDmPeers` set), never a cold stranger, and a known caller who arrives
 * mid-call gets a passive "Missed call" notice instead of silence.
 */
describe("DmCallProvider ring gate", () => {
  const ring = vi.mocked(startIncomingRing);

  function makeOffer(author: string): OpenedDm {
    return {
      rumorId: "e".repeat(64),
      author,
      kind: KIND_DM_CALL,
      content: "offer",
      // parseDmCall reads the peer from `peers`, not a tag; the secret is
      // verified against the call id, so both must be the minted pair.
      tags: [["call", callId], ["secret", secretHex], ["broker", broker]],
      createdAt: Math.floor(Date.now() / 1000),
      peers: [author],
      wrapId: "f".repeat(64),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    activeCall.current = null;
    known.peers = [];
    // Clears the bus listeners AND the rumor-id dedup, so each test's provider
    // subscribes fresh and the shared rumor id is deliverable again. Runs before
    // any render below, so it never strips the mounted provider's listener.
    _resetDmCallBusForTests();
  });

  it("rings for a known caller", () => {
    known.peers = [realPeer];
    renderAt(`/dm/${realPeer}`);
    act(() => deliverDmCallRumors([makeOffer(realPeer)]));
    expect(ring).toHaveBeenCalledTimes(1);
  });

  it("drops a stranger's offer silently", () => {
    known.peers = [];
    renderAt(`/dm/${realPeer}`);
    act(() => deliverDmCallRumors([makeOffer(realPeer)]));
    expect(ring).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("shows a missed-call notice for a known caller while busy", () => {
    known.peers = [realPeer];
    activeCall.current = { dm: { callId: "d".repeat(64), peer: pathPeer } };
    renderAt(`/dm/${realPeer}`);
    act(() => deliverDmCallRumors([makeOffer(realPeer)]));
    expect(ring).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Missed call" }),
    );
  });
});

/**
 * Both ends of a call attempt: what the callee tells the caller, what the
 * caller makes of it, and two people dialing each other at the same moment.
 */
describe("DmCallProvider signaling", () => {
  const ring = vi.mocked(startIncomingRing);
  /** Lower than `self`, so this peer's call wins a collision with ours. */
  const lowPeer = "1".repeat(64);
  const ctx: { current: DmCallState | null } = { current: null };
  let seq = 0;

  function Capture() {
    ctx.current = useDmCall();
    return null;
  }

  const tree = () => (
    <MemoryRouter initialEntries={[`/dm/${realPeer}`]}>
      <DmCallProvider>
        <Capture />
      </DmCallProvider>
    </MemoryRouter>
  );

  function rumor(author: string, content: string, tags: string[][]): OpenedDm {
    return {
      rumorId: (++seq).toString(16).padStart(64, "0"),
      author,
      kind: KIND_DM_CALL,
      content,
      tags,
      createdAt: Math.floor(Date.now() / 1000),
      peers: [author],
      wrapId: "f".repeat(64),
    };
  }

  function offerFrom(author: string) {
    const call = mintDmCall();
    return {
      callId: call.callId,
      rumor: rumor(author, "offer", dmCallTags(self, call.callId, { secretHex: call.secretHex, broker })),
    };
  }

  /** Every signal sent to someone other than ourselves, in order. */
  function sent() {
    return publish.mock.calls
      .map(([wrap]) => wrap as { rumor: { content: string; tags: string[][] }; recipient: string })
      .filter((w) => w.recipient !== self)
      .map((w) => ({
        phase: w.rumor.content,
        to: w.recipient,
        callId: w.rumor.tags.find((t) => t[0] === "call")?.[1],
      }));
  }

  /** Every self-addressed copy (what our other devices fold), in order. */
  function ownCopies() {
    return publish.mock.calls
      .map(([wrap]) => wrap as { rumor: { content: string; tags: string[][] }; recipient: string })
      .filter((w) => w.recipient === self)
      .map((w) => ({
        phase: w.rumor.content,
        callId: w.rumor.tags.find((t) => t[0] === "call")?.[1],
      }));
  }

  /** Place a call to `peer` and let the room come up; resolves to its call id. */
  async function placeCall(view: ReturnType<typeof render>, peer: string): Promise<string> {
    await act(() => ctx.current!.startCall(peer));
    const ours = joinDmCall.mock.calls.at(-1)![0];
    activeCall.current = { dm: ours };
    view.rerender(tree());
    return ours.callId;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    activeCall.current = null;
    known.peers = [realPeer, lowPeer];
    app.config = { useOwnDmRelays: true, dmRelays: ["wss://dm.example"] };
    probe.fn.mockImplementation(async () => true);
    sessionStorage.removeItem("armada:dm-call-own-ids");
    _resetDmCallBusForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    app.config = {};
  });

  describe("the callee's receipts", () => {
    it("tells a known caller the call is ringing", async () => {
      render(tree());
      const offer = offerFrom(realPeer);
      act(() => deliverDmCallRumors([offer.rumor]));
      expect(ring).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(sent()).toContainEqual({ phase: "ringing", to: realPeer, callId: offer.callId }),
      );
    });

    it("tells a known caller we are busy", async () => {
      activeCall.current = { dm: { callId: "d".repeat(64), peer: pathPeer } };
      render(tree());
      const offer = offerFrom(realPeer);
      act(() => deliverDmCallRumors([offer.rumor]));
      await waitFor(() =>
        expect(sent()).toContainEqual({ phase: "busy", to: realPeer, callId: offer.callId }),
      );
    });

    it("is not busy in a voice channel, so our other devices keep ringing", async () => {
      activeCall.current = { relayUrl: "", groupId: "g", concord: {} };
      render(tree());
      const offer = offerFrom(realPeer);
      act(() => deliverDmCallRumors([offer.rumor]));
      await new Promise((r) => setTimeout(r, 20));
      expect(sent()).not.toContainEqual(expect.objectContaining({ phase: "busy" }));
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ description: expect.stringMatching(/voice channel/i) }),
      );
    });

    it("sends one ringing receipt per call id", async () => {
      render(tree());
      const offer = offerFrom(realPeer);
      const ringings = () => sent().filter((m) => m.phase === "ringing").length;
      act(() => deliverDmCallRumors([offer.rumor]));
      await waitFor(() => expect(ringings()).toBeGreaterThan(0));
      // One receipt, however many relays carried it.
      const once = ringings();
      act(() => ctx.current!.declineCall());
      // The same call re-delivered under another rumor id.
      act(() => deliverDmCallRumors([{ ...offer.rumor, rumorId: "9".repeat(64) }]));
      await new Promise((r) => setTimeout(r, 20));
      expect(ringings()).toBe(once);
    });

    it("sends no receipts from a signer that may prompt per signature", async () => {
      login.method = "extension";
      try {
        render(tree());
        act(() => deliverDmCallRumors([offerFrom(realPeer).rumor]));
        expect(ring).toHaveBeenCalledTimes(1);
        await new Promise((r) => setTimeout(r, 20));
        expect(sent()).toEqual([]);
      } finally {
        login.method = "nsec";
      }
    });

    it("tells a stranger nothing", async () => {
      known.peers = [];
      render(tree());
      act(() => deliverDmCallRumors([offerFrom(realPeer).rumor]));
      await new Promise((r) => setTimeout(r, 20));
      expect(sent()).toEqual([]);
    });
  });

  describe("the caller's feedback", () => {
    it("says 'No answer' when the peer's device rang", async () => {
      vi.useFakeTimers();
      const view = render(tree());
      const ours = await placeCall(view, realPeer);
      act(() => deliverDmCallRumors([rumor(realPeer, "ringing", dmCallTags(self, ours))]));
      await act(() => vi.advanceTimersByTimeAsync(DM_CALL_RING_MS + 100));
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "No answer" }));
    });

    it("explains, without overclaiming, when no device of the peer's said it rang", async () => {
      vi.useFakeTimers();
      const view = render(tree());
      await placeCall(view, realPeer);
      await act(() => vi.advanceTimersByTimeAsync(DM_CALL_RING_MS + 100));
      // An older callee rings without a receipt, so "may not have", never "didn't".
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ description: expect.stringMatching(/may not have rung.*follow/i) }),
      );
    });

    it("ignores receipts for our call id from anyone but the peer", async () => {
      vi.useFakeTimers();
      const view = render(tree());
      const ours = await placeCall(view, realPeer);
      act(() =>
        deliverDmCallRumors([
          rumor(pathPeer, "busy", dmCallTags(self, ours)),
          rumor(pathPeer, "ringing", dmCallTags(self, ours)),
        ]),
      );
      expect(leaveCall).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTimeAsync(DM_CALL_RING_MS + 100));
      // Still unreached: the third party's "ringing" did not count.
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ description: expect.stringMatching(/may not have rung/i) }),
      );
    });

    it("ends the attempt at once when the peer is busy", async () => {
      const view = render(tree());
      const ours = await placeCall(view, realPeer);
      act(() => deliverDmCallRumors([rumor(realPeer, "busy", dmCallTags(self, ours))]));
      expect(leaveCall).toHaveBeenCalled();
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringMatching(/another call/i) }),
      );
    });

    it("ignores a busy receipt for some other call", async () => {
      const view = render(tree());
      await placeCall(view, realPeer);
      act(() => deliverDmCallRumors([rumor(realPeer, "busy", dmCallTags(self, "d".repeat(64)))]));
      expect(leaveCall).not.toHaveBeenCalled();
    });
  });

  describe("two people calling each other at once", () => {
    it("switches to the peer's call when theirs wins the tie-break", async () => {
      const view = render(tree());
      const ours = await placeCall(view, lowPeer);
      const theirs = offerFrom(lowPeer);
      act(() => deliverDmCallRumors([theirs.rumor]));
      // Joined THEIR room and told them so — not a ring, not a missed call.
      expect(joinDmCall).toHaveBeenLastCalledWith(
        expect.objectContaining({ peer: lowPeer, callId: theirs.callId }),
      );
      expect(ring).not.toHaveBeenCalled();
      expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Missed call" }));
      await waitFor(() =>
        expect(sent()).toContainEqual({ phase: "answer", to: lowPeer, callId: theirs.callId }),
      );
      expect(sent()).not.toContainEqual(expect.objectContaining({ phase: "busy" }));
      expect(ours).not.toBe(theirs.callId);
    });

    it("stays in our call when ours wins, for the peer to join", async () => {
      const view = render(tree());
      const ours = await placeCall(view, realPeer);
      act(() => deliverDmCallRumors([offerFrom(realPeer).rumor]));
      expect(joinDmCall).toHaveBeenCalledTimes(1);
      expect(joinDmCall).toHaveBeenLastCalledWith(expect.objectContaining({ callId: ours }));
      expect(ring).not.toHaveBeenCalled();
      expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Missed call" }));
      await new Promise((r) => setTimeout(r, 20));
      expect(sent()).not.toContainEqual(expect.objectContaining({ phase: "busy" }));
    });

    it("ignores the losing offer when it lands after the loser answered ours", async () => {
      const view = render(tree());
      const ours = await placeCall(view, realPeer);
      act(() => deliverDmCallRumors([rumor(realPeer, "answer", dmCallTags(self, ours))]));
      act(() => deliverDmCallRumors([offerFrom(realPeer).rumor]));
      expect(ring).not.toHaveBeenCalled();
      expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Missed call" }));
      await new Promise((r) => setTimeout(r, 20));
      expect(sent()).not.toContainEqual(expect.objectContaining({ phase: "busy" }));
      expect(joinDmCall).toHaveBeenCalledTimes(1);
    });

    it("tells our other devices to stop ringing for the offer it dropped", async () => {
      const view = render(tree());
      await placeCall(view, realPeer);
      const theirs = offerFrom(realPeer);
      act(() => deliverDmCallRumors([theirs.rumor]));
      await waitFor(() =>
        expect(ownCopies()).toContainEqual({ phase: "answer", callId: theirs.callId }),
      );
      // To our devices only: the peer is joining our call, not being answered.
      expect(sent()).not.toContainEqual(expect.objectContaining({ callId: theirs.callId }));
    });

    it("does not ring for a peer another device of ours is dialing", () => {
      render(tree());
      const siblings = mintDmCall();
      act(() =>
        deliverDmCallRumors([
          {
            ...rumor(self, "offer", dmCallTags(realPeer, siblings.callId, { secretHex: siblings.secretHex, broker })),
            peers: [realPeer],
          },
        ]),
      );
      act(() => deliverDmCallRumors([offerFrom(realPeer).rumor]));
      expect(ring).not.toHaveBeenCalled();
    });

    it("does not read a late copy of this tab's own pre-reload offer as a sibling dialing", () => {
      // The call id this tab minted before a reload, remembered in its session.
      const before = mintDmCall();
      sessionStorage.setItem("armada:dm-call-own-ids", JSON.stringify([before.callId]));
      try {
        render(tree());
        act(() =>
          deliverDmCallRumors([
            {
              ...rumor(self, "offer", dmCallTags(realPeer, before.callId, { secretHex: before.secretHex, broker })),
              peers: [realPeer],
            },
          ]),
        );
        act(() => deliverDmCallRumors([offerFrom(realPeer).rumor]));
        expect(ring).toHaveBeenCalledTimes(1);
      } finally {
        sessionStorage.removeItem("armada:dm-call-own-ids");
      }
    });

    it("stops deferring to a sibling's dial once its offer's ring window is over", () => {
      render(tree());
      const siblings = mintDmCall();
      // Barely fresh when it lands: it can only hold our ring for a second.
      const stale = rumor(self, "offer", dmCallTags(realPeer, siblings.callId, { secretHex: siblings.secretHex, broker }));
      act(() =>
        deliverDmCallRumors([
          { ...stale, createdAt: Math.floor((Date.now() - DM_CALL_RING_MS + 1_000) / 1000), peers: [realPeer] },
        ]),
      );
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + 2_000);
      try {
        act(() => deliverDmCallRumors([offerFrom(realPeer).rumor]));
        expect(ring).toHaveBeenCalledTimes(1);
      } finally {
        clock.mockRestore();
      }
    });

    it("clears the Android call peer before the account exits", async () => {
      const { setNativeCallPeer } = await import("@/lib/nativeNotifications");
      const { runBeforeAccountExit } = await import("@/lib/beforeAccountExit");
      const view = render(tree());
      await placeCall(view, realPeer);
      expect(setNativeCallPeer).toHaveBeenLastCalledWith(realPeer);
      await runBeforeAccountExit("final-logout", 50);
      expect(setNativeCallPeer).toHaveBeenLastCalledWith(null);
    });

    it("joins the losing call when the loser never answers ours", async () => {
      vi.useFakeTimers();
      const view = render(tree());
      const ours = await placeCall(view, realPeer);
      const theirs = offerFrom(realPeer);
      act(() => deliverDmCallRumors([theirs.rumor]));
      await act(() => vi.advanceTimersByTimeAsync(DM_CALL_COLLISION_FALLBACK_MS + 100));
      expect(joinDmCall).toHaveBeenLastCalledWith(
        expect.objectContaining({ peer: realPeer, callId: theirs.callId }),
      );
      expect(sent()).toContainEqual({ phase: "answer", to: realPeer, callId: theirs.callId });
      expect(ours).not.toBe(theirs.callId);
    });

    it("starts the fallback clock only once our own offer is out", async () => {
      vi.useFakeTimers();
      let release!: (ok: boolean) => void;
      probe.fn.mockImplementationOnce(() => new Promise<boolean>((r) => (release = r)));
      const view = render(tree());
      let placing!: Promise<void>;
      act(() => {
        placing = ctx.current!.startCall(realPeer);
      });
      const theirs = offerFrom(realPeer);
      act(() => deliverDmCallRumors([theirs.rumor]));
      // Our broker probe outlasts what used to be the whole fallback window.
      await act(() => vi.advanceTimersByTimeAsync(DM_CALL_COLLISION_FALLBACK_MS + 100));
      expect(joinDmCall).not.toHaveBeenCalled();
      await act(async () => {
        release(true);
        await placing;
      });
      const ours = joinDmCall.mock.calls.at(-1)![0];
      expect(ours.callId).not.toBe(theirs.callId);
      activeCall.current = { dm: ours };
      view.rerender(tree());
      // The loser now has the full window from our send to answer it.
      await act(() => vi.advanceTimersByTimeAsync(DM_CALL_COLLISION_FALLBACK_MS - 1_000));
      expect(joinDmCall).toHaveBeenCalledTimes(1);
      await act(() => vi.advanceTimersByTimeAsync(2_000));
      expect(joinDmCall).toHaveBeenLastCalledWith(expect.objectContaining({ callId: theirs.callId }));
    });

    it("stays in our call when the loser's device reports ours ringing", async () => {
      vi.useFakeTimers();
      const view = render(tree());
      const ours = await placeCall(view, realPeer);
      const theirs = offerFrom(realPeer);
      act(() => deliverDmCallRumors([theirs.rumor]));
      act(() => deliverDmCallRumors([rumor(realPeer, "ringing", dmCallTags(self, ours))]));
      await act(() => vi.advanceTimersByTimeAsync(DM_CALL_COLLISION_FALLBACK_MS + 100));
      expect(joinDmCall).toHaveBeenCalledTimes(1);
      expect(joinDmCall).toHaveBeenLastCalledWith(expect.objectContaining({ callId: ours }));
    });

    it("does not dismiss colliding offers on our devices from a prompting signer", async () => {
      login.method = "extension";
      try {
        const view = render(tree());
        await placeCall(view, realPeer);
        const theirs = offerFrom(realPeer);
        act(() => deliverDmCallRumors([theirs.rumor]));
        await new Promise((r) => setTimeout(r, 20));
        expect(ownCopies()).not.toContainEqual(expect.objectContaining({ callId: theirs.callId }));
      } finally {
        login.method = "nsec";
      }
    });

    it("dismisses a burst of glare offers on our devices at most once", async () => {
      const view = render(tree());
      const ours = await placeCall(view, realPeer);
      act(() => deliverDmCallRumors([rumor(realPeer, "answer", dmCallTags(self, ours))]));
      const first = offerFrom(realPeer);
      const more = [offerFrom(realPeer), offerFrom(realPeer)];
      const ids = new Set([first.callId, ...more.map((o) => o.callId)]);
      act(() =>
        deliverDmCallRumors([
          first.rumor,
          { ...first.rumor, rumorId: "9".repeat(64) },
          ...more.map((o) => o.rumor),
        ]),
      );
      await waitFor(() => expect(ownCopies()).toContainEqual({ phase: "answer", callId: first.callId }));
      await new Promise((r) => setTimeout(r, 20));
      // One dismissal (fanned out over every scan relay), for the first call only.
      const dismissed = ownCopies().filter((c) => c.phase === "answer" && ids.has(c.callId!));
      expect(new Set(dismissed.map((c) => c.callId))).toEqual(new Set([first.callId]));
    });

    it("keeps our call when the loser withdraws its offer to join it", async () => {
      vi.useFakeTimers();
      const view = render(tree());
      const ours = await placeCall(view, realPeer);
      const theirs = offerFrom(realPeer);
      act(() => deliverDmCallRumors([theirs.rumor]));
      act(() => deliverDmCallRumors([rumor(realPeer, "end", dmCallTags(self, theirs.callId))]));
      await act(() => vi.advanceTimersByTimeAsync(DM_CALL_COLLISION_FALLBACK_MS + 100));
      expect(joinDmCall).toHaveBeenCalledTimes(1);
      expect(joinDmCall).toHaveBeenLastCalledWith(expect.objectContaining({ callId: ours }));
    });

    it("joins the losing call when our own offer could not be sent", async () => {
      let release!: (ok: boolean) => void;
      probe.fn.mockImplementationOnce(() => new Promise<boolean>((r) => (release = r)));
      render(tree());
      let placing!: Promise<void>;
      act(() => {
        placing = ctx.current!.startCall(realPeer);
      });
      const theirs = offerFrom(realPeer);
      act(() => deliverDmCallRumors([theirs.rumor]));
      publish.mockRejectedValue(new Error("offline"));
      await act(async () => {
        release(true);
        await placing;
      });
      publish.mockResolvedValue(undefined);
      expect(joinDmCall).toHaveBeenCalledTimes(1);
      expect(joinDmCall).toHaveBeenCalledWith(expect.objectContaining({ callId: theirs.callId }));
      expect(toastMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: "Could not start the call" }),
      );
    });

    it("resolves the collision for a peer outside the known set too", async () => {
      // We are the one dialing them: that is consent to talk, whatever the
      // ring gate would make of their offer on its own.
      known.peers = [];
      const view = render(tree());
      await placeCall(view, lowPeer);
      const theirs = offerFrom(lowPeer);
      act(() => deliverDmCallRumors([theirs.rumor]));
      expect(joinDmCall).toHaveBeenLastCalledWith(expect.objectContaining({ callId: theirs.callId }));
    });

    it("resolves a collision that lands while our offer is still being sent", async () => {
      let release!: (ok: boolean) => void;
      probe.fn.mockImplementationOnce(() => new Promise<boolean>((r) => (release = r)));
      render(tree());
      let placing!: Promise<void>;
      act(() => {
        placing = ctx.current!.startCall(lowPeer);
      });
      const theirs = offerFrom(lowPeer);
      act(() => deliverDmCallRumors([theirs.rumor]));
      await act(async () => {
        release(true);
        await placing;
      });
      expect(joinDmCall).toHaveBeenCalledTimes(1);
      expect(joinDmCall).toHaveBeenCalledWith(expect.objectContaining({ callId: theirs.callId }));
      expect(ring).not.toHaveBeenCalled();
      expect(sent()).not.toContainEqual(expect.objectContaining({ phase: "offer" }));
    });

    it("answers the peer's ringing call instead of dialing a second one", async () => {
      render(tree());
      const theirs = offerFrom(realPeer);
      act(() => deliverDmCallRumors([theirs.rumor]));
      expect(ring).toHaveBeenCalledTimes(1);
      await act(() => ctx.current!.startCall(realPeer));
      expect(joinDmCall).toHaveBeenCalledTimes(1);
      expect(joinDmCall).toHaveBeenCalledWith(expect.objectContaining({ callId: theirs.callId }));
      expect(sent()).not.toContainEqual(expect.objectContaining({ phase: "offer" }));
    });
  });
});
