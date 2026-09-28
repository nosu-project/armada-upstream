import { describe, expect, it } from "vitest";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { NostrRelayCLOSED, NostrRelayEOSE, NostrRelayEVENT } from "@nostrify/types";

import { queryRelayStrict, RelaySubscriptionClosedError, type ReqRelay } from "./strictRelayQuery";

type Msg = NostrRelayEVENT | NostrRelayEOSE | NostrRelayCLOSED;

function event(n: number): NostrEvent {
  return {
    id: n.toString(16).padStart(64, "0"),
    pubkey: "a".repeat(64),
    kind: 1,
    created_at: n,
    content: "",
    tags: [],
    sig: "b".repeat(128),
  };
}

/** A relay whose `req` yields `msgs` and then ends — as NRelay1.req does at CLOSED. */
function relayYielding(msgs: Msg[]): ReqRelay & { reqs: number } {
  const relay = {
    reqs: 0,
    async *req(_filters: NostrFilter[], opts?: { signal?: AbortSignal }) {
      relay.reqs++;
      for (const msg of msgs) {
        opts?.signal?.throwIfAborted();
        // NRelay1.req never yields CLOSED: it ends the stream there.
        if (msg[0] === "CLOSED") return;
        yield msg;
      }
    },
  };
  return relay;
}

describe("queryRelayStrict", () => {
  it("returns the stored events up to EOSE", async () => {
    const relay = relayYielding([["EVENT", "s", event(1)], ["EVENT", "s", event(2)], ["EOSE", "s"]]);
    expect(await queryRelayStrict(relay, [{ kinds: [1] }])).toEqual([event(1), event(2)]);
  });

  it("resolves an empty answer that ended in EOSE", async () => {
    expect(await queryRelayStrict(relayYielding([["EOSE", "s"]]), [{ kinds: [1] }])).toEqual([]);
  });

  it("rejects when the relay CLOSED the subscription instead of answering", async () => {
    const relay = relayYielding([["CLOSED", "s", "auth-required: authenticate first"]]);
    await expect(queryRelayStrict(relay, [{ kinds: [1] }])).rejects.toBeInstanceOf(RelaySubscriptionClosedError);
  });

  it("rejects a CLOSED that arrives after some events, since the answer is partial", async () => {
    const relay = relayYielding([["EVENT", "s", event(1)], ["CLOSED", "s", "rate-limited: slow down"]]);
    await expect(queryRelayStrict(relay, [{ kinds: [1] }])).rejects.toBeInstanceOf(RelaySubscriptionClosedError);
  });

  it("treats reaching the combined limit as a complete answer", async () => {
    const relay = relayYielding([["EVENT", "s", event(1)], ["EVENT", "s", event(2)], ["CLOSED", "s", "x"]]);
    expect(await queryRelayStrict(relay, [{ kinds: [1], limit: 1 }, { kinds: [2], limit: 1 }]))
      .toEqual([event(1), event(2)]);
  });

  it("deduplicates an event matched by two filters", async () => {
    const relay = relayYielding([["EVENT", "s", event(1)], ["EVENT", "s", event(1)], ["EOSE", "s"]]);
    expect(await queryRelayStrict(relay, [{ kinds: [1] }, { ids: [event(1).id] }])).toEqual([event(1)]);
  });

  it("does not open a subscription for a filter set that can match nothing", async () => {
    const relay = relayYielding([["EOSE", "s"]]);
    expect(await queryRelayStrict(relay, [{ ids: [] }])).toEqual([]);
    expect(relay.reqs).toBe(0);
  });

  it("rejects with the abort, not as CLOSED, when the signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    const relay = relayYielding([["EVENT", "s", event(1)], ["EOSE", "s"]]);
    await expect(queryRelayStrict(relay, [{ kinds: [1] }], { signal: controller.signal }))
      .rejects.not.toBeInstanceOf(RelaySubscriptionClosedError);
  });
});
