import { act, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DmCallProvider } from "./DmCallProvider";
import {
  _resetDmCallBusForTests,
  deliverDmCallRumors,
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

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({ nostr: { group: () => ({ event: publish }), event: publish } }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({
    user: {
      pubkey: self,
      signer: { nip44: { encrypt: async () => "", decrypt: async () => "" } },
    },
  }),
}));
vi.mock("@/hooks/useAppContext", () => ({ useAppContext: () => ({ config: {} }) }));
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
vi.mock("@/lib/nativeNotifications", () => ({ consumeNativeCallAnswer: vi.fn() }));
// The incoming-call overlay's identity surface pulls TanStack Query / the event
// store; stub it so a ringing test doesn't need those providers.
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/components/DmAvatar", () => ({ DmAvatar: () => null }));
vi.mock("@/components/DisplayName", () => ({ DisplayName: () => null }));

const activeCall: { current: unknown } = { current: null };
vi.mock("@/hooks/useCall", () => ({
  useCall: () => ({ activeCall: activeCall.current, joinDmCall, leaveCall: vi.fn() }),
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
