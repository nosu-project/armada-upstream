import { beforeEach, describe, expect, it, vi } from "vitest";

import { defragment, fragment, parseFragList, serializeFragList } from "@/concord/lib/listFrag";
import { STOCK_RELAYS } from "@/concord/lib/invite";
import {
  mirrorPortableStateBeforeRelayChange,
  portableConfigSnapshot,
  publishSignedPortableRecords,
  signedPortableSingletonWinner,
} from "@/hooks/usePublishPortableSetup";

import type { NostrEvent } from "@nostrify/nostrify";

const SELF = "a".repeat(64);
const h = vi.hoisted(() => ({
  events: [] as NostrEvent[],
  queryStatus: vi.fn(),
  withSignature: vi.fn(),
  queue: vi.fn(async (..._args: unknown[]) => undefined),
  signDmTopics: vi.fn(async (..._args: unknown[]) => [] as NostrEvent[]),
  signGifTopics: vi.fn(async (..._args: unknown[]) => [] as NostrEvent[]),
  folded: new Map<string, unknown>(),
}));

vi.mock("@/hooks/useDmConversationIndexSync", () => ({
  signCurrentDmConversationIndexEvents: (...args: unknown[]) => h.signDmTopics(...args),
}));

vi.mock("@/hooks/useFavoriteGifsSync", () => ({
  signCurrentFavoriteGifEvents: (...args: unknown[]) => h.signGifTopics(...args),
}));

vi.mock("@/lib/foldedCache", () => ({
  readFolded: async (key: string) => h.folded.get(key),
  writeFolded: async (key: string, value: unknown) => { h.folded.set(key, value); },
}));

vi.mock("@/lib/publishOutbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/publishOutbox")>()),
  queueSignedEvent: (...args: unknown[]) => h.queue(...args),
  recordQueuedPublishAttempt: vi.fn(async () => undefined),
  withSignature: (...args: unknown[]) => h.withSignature(...args),
}));

vi.mock("@/lib/nip65", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/nip65")>();
  return {
    ...actual,
    queryExplicitRelaysWithStatus: (...args: unknown[]) => h.queryStatus(...args),
  };
});

function event(kind: number, id: string, content: string, tags: string[][]): NostrEvent {
  return {
    kind,
    id: id.padEnd(64, id).slice(0, 64),
    pubkey: SELF,
    content,
    tags,
    created_at: 10,
    sig: id.padEnd(128, id).slice(0, 128),
  };
}

beforeEach(() => {
  h.queryStatus.mockReset().mockImplementation(async (
    _nostr: unknown,
    relays: Iterable<string>,
  ) => ({ events: h.events, answered: [...relays], failed: [] }));
  h.queue.mockReset().mockResolvedValue(undefined);
  h.withSignature.mockReset().mockImplementation(async (rumor: NostrEvent) => {
    if (rumor.sig) return rumor;
    throw new Error("signature was not retained");
  });
  h.signDmTopics.mockReset().mockResolvedValue([]);
  h.signGifTopics.mockReset().mockResolvedValue([]);
  h.folded.clear();
  const [frag] = fragment({
    entries: [],
    tombstones: [{ community_id: "b".repeat(64), removed_at: 5 }],
  });
  h.events = [
    event(33302, "1", `sealed:${serializeFragList(frag)}`, [["d", "0"]]),
    event(13303, "2", `sealed:${JSON.stringify({
      entries: [{
        token: "01".repeat(16),
        signer_sk: "02".repeat(32),
        community_id: "c".repeat(64),
        url: "https://armada.buzz/invite/example#secret",
        created_at: 5,
      }],
      tombstones: [],
    })}`, []),
  ];
});

describe("portable Concord exact mirroring", () => {
  it("does not begin network fan-out when durable queue persistence fails", async () => {
    h.queue.mockRejectedValueOnce(new Error("KV unavailable"));
    const relayEvent = vi.fn(async () => undefined);
    const nostr = { relay: () => ({ event: relayEvent }) };

    await expect(publishSignedPortableRecords(
      nostr as never,
      [h.events[0]!],
      ["wss://new.example"],
    )).rejects.toThrow("KV unavailable");
    expect(relayEvent).not.toHaveBeenCalled();
  });

  it("refuses to mirror an older wire singleton over a newer unsigned local winner", async () => {
    const staleWire = event(10050, "a", "", [["relay", "wss://stale.example"]]);
    const { sig: _sig, ...newerLocal } = {
      ...event(10050, "b", "", [["relay", "wss://new.example"]]),
      created_at: 20,
    };

    await expect(signedPortableSingletonWinner(
      [staleWire],
      [newerLocal],
      10050,
    )).rejects.toThrow(/newer local setup record/i);
  });

  it("uses a newer signed ArmadaDB read-state document instead of an older relay copy", async () => {
    const staleWire = event(30078, "a", "old", [["d", "armada/read-state"]]);
    const newerLocal = {
      ...event(30078, "b", "new", [["d", "armada/read-state"]]),
      created_at: 20,
    };

    await expect(signedPortableSingletonWinner(
      [staleWire],
      [newerLocal],
      30078,
    )).resolves.toEqual(newerLocal);
  });

  it("unions additive DM state before explicit Setup Sync re-signs it", () => {
    const older = { createdAt: 10, eventId: "old" };
    const newer = { createdAt: 20, eventId: "new" };
    const patch = portableConfigSnapshot(
      "dms",
      {
        dmProtocol: { remote: "nip17" },
        pinnedDms: ["remote"],
        closedDms: { same: newer, remote: older },
        acceptedDms: ["remote"],
        startedDms: ["remote"],
      },
      {
        dmProtocol: { local: "nip04" },
        pinnedDms: ["local"],
        closedDms: { same: older, local: newer },
        acceptedDms: ["local"],
        startedDms: ["local"],
      } as never,
    );

    expect(patch).toMatchObject({
      dmProtocol: { local: "nip04" },
      pinnedDms: ["local", "remote"],
      closedDms: { same: newer, remote: older, local: newer },
      acceptedDms: ["local", "remote"],
      startedDms: ["local", "remote"],
    });
  });

  it("fans the exact signed 33302 and 13303 bytes to a proposed relay", async () => {
    const delivered: Array<{ url: string; event: NostrEvent }> = [];
    const nostr = {
      query: async () => [],
      relay: (url: string) => ({
        query: async () => [],
        event: async (wireEvent: NostrEvent) => { delivered.push({ url, event: wireEvent }); },
      }),
    };
    const user = {
      pubkey: SELF,
      signer: {
        nip44: {
          decrypt: async (_pubkey: string, ciphertext: string) => ciphertext.slice("sealed:".length),
        },
      },
    };

    await mirrorPortableStateBeforeRelayChange(
      nostr as never,
      user as never,
      ["wss://old.example"],
      ["wss://new.example"],
    );

    const mirrored = delivered.filter(({ url }) => url === "wss://new.example").map(({ event }) => event);
    expect(mirrored.map(({ kind }) => kind).sort()).toEqual([13303, 33302]);
    for (const original of h.events) {
      expect(mirrored.find(({ id }) => id === original.id)).toEqual(original);
    }
  });

  it("includes a proposed relay's newer coordinate in the phase-one merge", async () => {
    const oldSearch = {
      ...event(10007, "8", "", [["relay", "wss://old-search.example"]]),
      created_at: 9,
    };
    const targetSearch = {
      ...event(10007, "9", "", [["relay", "wss://target-search.example"]]),
      created_at: 20,
    };
    h.events.push(oldSearch, targetSearch);
    const delivered: NostrEvent[] = [];
    const nostr = {
      query: async () => [],
      relay: () => ({
        query: async () => [],
        event: async (wireEvent: NostrEvent) => { delivered.push(wireEvent); },
      }),
    };
    const user = {
      pubkey: SELF,
      signer: {
        nip44: {
          decrypt: async (_pubkey: string, ciphertext: string) => ciphertext.slice("sealed:".length),
        },
      },
    };

    await mirrorPortableStateBeforeRelayChange(
      nostr as never,
      user as never,
      ["wss://old.example"],
      ["wss://new.example"],
    );

    expect(delivered.some(({ id }) => id === targetSearch.id)).toBe(true);
    expect(delivered.some(({ id }) => id === oldSearch.id)).toBe(false);
  });

  it("re-signs newer local group, fixed-setting, and topic rumors before rotation", async () => {
    const staleGroup = event(10009, "b", "stale-groups", []);
    const staleSetting = event(30078, "c", "stale-setting", [["d", "armada/read-state"]]);
    const { sig: _groupSig, ...localGroup } = {
      ...event(10009, "d", "local-groups", []),
      created_at: 20,
    };
    const { sig: _settingSig, ...localSetting } = {
      ...event(30078, "e", "local-setting", [["d", "armada/read-state"]]),
      created_at: 20,
    };
    const topicD = "armada/dm-conversations/local/0";
    const { sig: _topicSig, ...localTopic } = {
      ...event(30078, "f", "local-topic", [["d", topicD], ["t", "armada-dm-conversations"]]),
      created_at: 20,
    };
    h.events.push(staleGroup, staleSetting);
    const delivered: NostrEvent[] = [];
    h.queryStatus.mockImplementation(async (
      _nostr: unknown,
      relays: Iterable<string>,
    ) => ({ events: [...h.events, ...delivered], answered: [...relays], failed: [] }));
    const signedIds = ["7", "8", "9"];
    let signed = 0;
    const nostr = {
      query: async () => [],
      relay: () => ({
        query: async () => [],
        event: async (wireEvent: NostrEvent) => { delivered.push(wireEvent); },
      }),
    };
    const user = {
      pubkey: SELF,
      signer: {
        nip44: {
          decrypt: async (_pubkey: string, ciphertext: string) => ciphertext.slice("sealed:".length),
        },
        signEvent: async (template: {
          kind: number;
          content: string;
          tags: string[][];
          created_at: number;
        }) => ({
          ...event(template.kind, signedIds[signed++]!, template.content, template.tags),
          created_at: template.created_at,
        }),
      },
    };

    const first = await mirrorPortableStateBeforeRelayChange(
      nostr as never,
      user as never,
      ["wss://old.example"],
      ["wss://new.example"],
      ["wss://old.example"],
      true,
      [localGroup, localSetting, localTopic],
    );
    const second = await mirrorPortableStateBeforeRelayChange(
      nostr as never,
      user as never,
      ["wss://old.example"],
      ["wss://new.example"],
      ["wss://old.example"],
      true,
      [localGroup, localSetting, localTopic],
    );

    expect(delivered).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 10009, content: "local-groups" }),
      expect.objectContaining({ kind: 30078, content: "local-setting" }),
      expect.objectContaining({ kind: 30078, content: "local-topic" }),
    ]));
    expect(delivered.some(({ id }) => id === staleGroup.id || id === staleSetting.id)).toBe(false);
    expect(h.signDmTopics.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([localTopic]));
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(signed).toBe(3);
  });

  it("does not switch when a proposed relay ACKs but retains a newer coordinate head", async () => {
    const expected = {
      ...event(10007, "0", "", [["relay", "wss://expected.example"]]),
      created_at: 20,
    };
    const unexpected = {
      ...event(10007, "a", "", [["relay", "wss://unexpected.example"]]),
      created_at: 50,
    };
    h.events.push(expected);
    h.queryStatus
      .mockImplementationOnce(async (
        _nostr: unknown,
        relays: Iterable<string>,
      ) => ({ events: h.events, answered: [...relays], failed: [] }))
      .mockImplementationOnce(async (
        _nostr: unknown,
        relays: Iterable<string>,
      ) => ({ events: h.events, answered: [...relays], failed: [] }))
      .mockImplementation(async (
        _nostr: unknown,
        relays: Iterable<string>,
      ) => ({ events: [...h.events, unexpected], answered: [...relays], failed: [] }));
    const relayEvent = vi.fn(async () => undefined);
    const nostr = {
      query: async () => [],
      relay: () => ({ query: async () => [], event: relayEvent }),
    };
    const user = {
      pubkey: SELF,
      signer: {
        nip44: {
          decrypt: async (_pubkey: string, ciphertext: string) => ciphertext.slice("sealed:".length),
        },
      },
    };

    await expect(mirrorPortableStateBeforeRelayChange(
      nostr as never,
      user as never,
      ["wss://old.example"],
      ["wss://new.example"],
    )).rejects.toThrow(/did not retain setup record kind 10007/i);
    expect(relayEvent).toHaveBeenCalled();
  });

  it("consolidates a durable invite fold that is ahead of wire", async () => {
    h.folded.set(`concord2-invite-list:${SELF}`, {
      newestCreatedAt: 20,
      list: {
        entries: [{
          token: "05".repeat(16),
          signer_sk: "06".repeat(32),
          community_id: "d".repeat(64),
          url: "https://armada.buzz/invite/local#secret",
          created_at: 20,
        }],
        tombstones: [],
      },
    });
    const delivered: NostrEvent[] = [];
    h.queryStatus.mockImplementation(async (
      _nostr: unknown,
      relays: Iterable<string>,
    ) => ({ events: [...h.events, ...delivered], answered: [...relays], failed: [] }));
    const nostr = {
      query: async () => [],
      relay: () => ({
        query: async () => [],
        event: async (wireEvent: NostrEvent) => { delivered.push(wireEvent); },
      }),
    };
    const user = {
      pubkey: SELF,
      signer: {
        nip44: {
          decrypt: async (_pubkey: string, ciphertext: string) => ciphertext.slice("sealed:".length),
          encrypt: async (_pubkey: string, plaintext: string) => `sealed:${plaintext}`,
        },
        signEvent: async (template: {
          kind: number;
          content: string;
          tags: string[][];
          created_at: number;
        }) => ({ ...event(template.kind, "4", template.content, template.tags), created_at: template.created_at }),
      },
    };

    await mirrorPortableStateBeforeRelayChange(
      nostr as never,
      user as never,
      ["wss://old.example"],
      ["wss://new.example"],
    );
    const invite = delivered.find(({ kind, id }) =>
      kind === 13303 && !h.events.some((original) => original.id === id));
    const list = JSON.parse(invite!.content.slice("sealed:".length)) as { entries: unknown[] };
    expect(list.entries).toHaveLength(2);
  });

  it("restores a newer invite revocation held only on a stock rescue relay", async () => {
    const stockRevocation = {
      ...event(13303, "e", `sealed:${JSON.stringify({
        entries: [],
        tombstones: [{
          token: "01".repeat(16),
          community_id: "c".repeat(64),
        }],
      })}`, []),
      created_at: 20,
    };
    const delivered: NostrEvent[] = [];
    h.queryStatus.mockImplementation(async (
      _nostr: unknown,
      relaysValue: Iterable<string>,
      filtersValue: unknown,
    ) => {
      const relays = [...relaysValue];
      const filters = filtersValue as Array<{ kinds?: number[] }>;
      const inviteOnly = filters.length === 1
        && filters[0]?.kinds?.length === 1
        && filters[0].kinds[0] === 13303;
      const stockRead = inviteOnly && relays.some((url) => STOCK_RELAYS.includes(url));
      return {
        events: stockRead ? [stockRevocation] : [...h.events, ...delivered],
        answered: relays,
        failed: [],
      };
    });
    const nostr = {
      query: async () => [],
      relay: () => ({
        query: async () => [],
        event: async (wireEvent: NostrEvent) => { delivered.push(wireEvent); },
      }),
    };
    const user = {
      pubkey: SELF,
      signer: {
        nip44: {
          decrypt: async (_pubkey: string, ciphertext: string) => ciphertext.slice("sealed:".length),
        },
      },
    };

    await mirrorPortableStateBeforeRelayChange(
      nostr as never,
      user as never,
      ["wss://old.example"],
      ["wss://new.example"],
    );

    expect(delivered.some(({ id }) => id === stockRevocation.id)).toBe(true);
    expect(delivered.some(({ id }) => id === h.events[1]?.id)).toBe(false);
  });

  it("re-signs a newer local invite revocation over a stale wire entry", async () => {
    const { sig: _sig, ...localRevocation } = {
      ...event(13303, "e", `sealed:${JSON.stringify({
        entries: [],
        tombstones: [{
          token: "01".repeat(16),
          community_id: "c".repeat(64),
        }],
      })}`, []),
      created_at: 20,
    };
    const delivered: NostrEvent[] = [];
    h.queryStatus.mockImplementation(async (
      _nostr: unknown,
      relays: Iterable<string>,
    ) => ({ events: [...h.events, ...delivered], answered: [...relays], failed: [] }));
    const nostr = {
      query: async () => [],
      relay: () => ({
        query: async () => [],
        event: async (wireEvent: NostrEvent) => { delivered.push(wireEvent); },
      }),
    };
    const user = {
      pubkey: SELF,
      signer: {
        nip44: {
          decrypt: async (_pubkey: string, ciphertext: string) => ciphertext.slice("sealed:".length),
          encrypt: async (_pubkey: string, plaintext: string) => `sealed:${plaintext}`,
        },
        signEvent: async (template: {
          kind: number;
          content: string;
          tags: string[][];
          created_at: number;
        }) => ({ ...event(template.kind, "f", template.content, template.tags), created_at: template.created_at }),
      },
    };

    await mirrorPortableStateBeforeRelayChange(
      nostr as never,
      user as never,
      ["wss://old.example"],
      ["wss://new.example"],
      ["wss://old.example"],
      true,
      [localRevocation],
    );

    const invite = delivered.find(({ kind, id }) =>
      kind === 13303 && !h.events.some((original) => original.id === id));
    const list = JSON.parse(invite!.content.slice("sealed:".length)) as {
      entries: unknown[];
      tombstones: unknown[];
    };
    expect(list.entries).toHaveLength(0);
    expect(list.tombstones).toHaveLength(1);
    expect(delivered.some(({ id }) => id === h.events[1]?.id)).toBe(false);
  });

  it("consolidates a proposed relay's richer older 33302 edition", async () => {
    const [richerFrag] = fragment({
      entries: [],
      tombstones: [{ community_id: "d".repeat(64), removed_at: 6 }],
    });
    const richer = {
      ...event(33302, "3", `sealed:${serializeFragList(richerFrag)}`, [["d", "0"]]),
      created_at: 9,
    };
    h.events = [h.events[0]!, richer, h.events[1]!];
    const delivered: NostrEvent[] = [];
    h.queryStatus.mockImplementation(async (
      _nostr: unknown,
      relays: Iterable<string>,
    ) => ({ events: [...h.events, ...delivered], answered: [...relays], failed: [] }));
    const nostr = {
      query: async () => [],
      relay: () => ({
        query: async () => [],
        event: async (wireEvent: NostrEvent) => { delivered.push(wireEvent); },
      }),
    };
    const user = {
      pubkey: SELF,
      signer: {
        nip44: {
          decrypt: async (_pubkey: string, ciphertext: string) => ciphertext.slice("sealed:".length),
          encrypt: async (_pubkey: string, plaintext: string) => `sealed:${plaintext}`,
        },
        signEvent: async (template: {
          kind: number;
          content: string;
          tags: string[][];
          created_at: number;
        }) => ({ ...event(template.kind, "a", template.content, template.tags), created_at: template.created_at }),
      },
    };

    await mirrorPortableStateBeforeRelayChange(
      nostr as never,
      user as never,
      ["wss://old.example"],
      ["wss://new.example"],
    );
    const consolidated = delivered.find(({ kind, id }) =>
      kind === 33302 && !h.events.some((original) => original.id === id));
    const parsed = parseFragList(consolidated!.content.slice("sealed:".length));
    expect(parsed && defragment([parsed]).tombstones).toHaveLength(2);
  });

  it("consolidates a newer unsigned ArmadaDB 33302 head", async () => {
    const [localFrag] = fragment({
      entries: [],
      tombstones: [{ community_id: "e".repeat(64), removed_at: 7 }],
    });
    const { sig: _sig, ...local } = {
      ...event(33302, "4", `sealed:${serializeFragList(localFrag)}`, [["d", "0"]]),
      created_at: 20,
    };
    const delivered: NostrEvent[] = [];
    h.queryStatus.mockImplementation(async (
      _nostr: unknown,
      relays: Iterable<string>,
    ) => ({ events: [...h.events, ...delivered], answered: [...relays], failed: [] }));
    const nostr = {
      query: async () => [],
      relay: () => ({
        query: async () => [],
        event: async (wireEvent: NostrEvent) => { delivered.push(wireEvent); },
      }),
    };
    const user = {
      pubkey: SELF,
      signer: {
        nip44: {
          decrypt: async (_pubkey: string, ciphertext: string) => ciphertext.slice("sealed:".length),
          encrypt: async (_pubkey: string, plaintext: string) => `sealed:${plaintext}`,
        },
        signEvent: async (template: {
          kind: number;
          content: string;
          tags: string[][];
          created_at: number;
        }) => ({ ...event(template.kind, "a", template.content, template.tags), created_at: template.created_at }),
      },
    };

    await mirrorPortableStateBeforeRelayChange(
      nostr as never,
      user as never,
      ["wss://old.example"],
      ["wss://new.example"],
      ["wss://old.example"],
      true,
      [local],
    );
    expect(delivered.some(({ kind, content }) =>
      kind === 33302 && content.includes("sealed:"))).toBe(true);
  });

  it("does not bless an empty bootstrap relay while the folded community vault has facts", async () => {
    h.events = [h.events[1]!]; // creator invites only; bootstrap relay has no 33302
    h.folded.set(`concord2-list:${SELF}`, {
      event: null,
      list: {
        entries: [],
        tombstones: [{ community_id: "f".repeat(64), removed_at: 8 }],
      },
    });
    const relayEvent = vi.fn();
    const nostr = {
      query: async () => [],
      relay: () => ({ query: async () => [], event: relayEvent }),
    };
    const user = {
      pubkey: SELF,
      signer: {
        nip44: {
          decrypt: async (_pubkey: string, ciphertext: string) => ciphertext.slice("sealed:".length),
        },
      },
    };

    await expect(mirrorPortableStateBeforeRelayChange(
      nostr as never,
      user as never,
      ["wss://bootstrap.example"],
      ["wss://new.example"],
      ["wss://bootstrap.example"],
      false,
    )).rejects.toThrow(/known community list was absent/i);
    expect(relayEvent).not.toHaveBeenCalled();
  });

  it("passes every divergent topic edition to consolidation and mirrors the repair, not the partial head", async () => {
    const topicD = "armada/dm-conversations/departed/0";
    const older = {
      ...event(30078, "5", "older-richer", [["d", topicD], ["t", "armada-dm-conversations"]]),
      created_at: 9,
    };
    const head = event(
      30078,
      "6",
      "newer-partial",
      [["d", topicD], ["t", "armada-dm-conversations"]],
    );
    const repair = {
      ...event(30078, "7", "semantic-union", [["d", topicD], ["t", "armada-dm-conversations"]]),
      created_at: 11,
    };
    h.events.push(older, head);
    h.signDmTopics.mockResolvedValue([repair]);
    const delivered: NostrEvent[] = [];
    h.queryStatus.mockImplementation(async (
      _nostr: unknown,
      relays: Iterable<string>,
    ) => ({ events: [...h.events, ...delivered], answered: [...relays], failed: [] }));
    const nostr = {
      query: async () => [],
      relay: () => ({
        query: async () => [],
        event: async (wireEvent: NostrEvent) => { delivered.push(wireEvent); },
      }),
    };
    const user = {
      pubkey: SELF,
      signer: {
        nip44: {
          decrypt: async (_pubkey: string, ciphertext: string) => ciphertext.slice("sealed:".length),
        },
      },
    };

    await mirrorPortableStateBeforeRelayChange(
      nostr as never,
      user as never,
      ["wss://old.example"],
      ["wss://new.example"],
    );

    expect(h.signDmTopics.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([older, head]));
    expect(delivered.some(({ id }) => id === repair.id)).toBe(true);
    expect(delivered.some(({ id }) => id === head.id)).toBe(false);
  });
});
