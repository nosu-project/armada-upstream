import { NIndexedDB } from "@nostrify/indexeddb";
import { IDBFactory } from "fake-indexeddb";
import { getConversationKey, decrypt as nip44Decrypt, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { bytesToHex, communityIdOf, hex32, random32 } from "@/concord-v2/lib/derive";
import {
  buildDirectInviteRumor,
  directInviteExpired,
  isCatchUpBundle,
  parseDirectInviteRumor,
  sealDirectInvite,
  unwrapDirectInvite,
  wrapDirectInvite,
  type DirectInviteSigner,
} from "@/concord-v2/lib/directInvite";
import {
  advanceInviteInboxCursor,
  inviteInboxSince,
  queryStoredInvites,
  storedToInvite,
  unwrappedToStored,
  writeStoredInvites,
  WRAP_BACKDATE_SECS,
} from "@/concord-v2/lib/inviteInbox";
import { KIND_DIRECT_INVITE, KIND_WRAP } from "@/concord-v2/lib/kinds";
import type { InviteBundle } from "@/concord-v2/lib/invite";

// A clean IndexedDB for the suite (the store singleton opens against it lazily).
(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();

/** A raw-key signer exposing the abstract surface a direct invite needs. */
function rawSigner(sk: Uint8Array): DirectInviteSigner {
  return {
    signEvent: async (template: EventTemplate) => finalizeEvent(template, sk),
    nip44: {
      encrypt: async (pubkey: string, plaintext: string) =>
        nip44Encrypt(plaintext, getConversationKey(sk, pubkey)),
      decrypt: async (pubkey: string, ciphertext: string) =>
        nip44Decrypt(ciphertext, getConversationKey(sk, pubkey)),
    },
  };
}

function makeBundle(overrides?: Partial<InviteBundle>): InviteBundle {
  const ownerHex = bytesToHex(random32());
  const salt = random32();
  return {
    community_id: bytesToHex(communityIdOf(hex32(ownerHex), salt)),
    owner: ownerHex,
    owner_salt: bytesToHex(salt),
    community_root: bytesToHex(random32()),
    root_epoch: 0,
    channels: [],
    relays: ["wss://a.example"],
    name: "Test community",
    ...overrides,
  };
}

async function eventually<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - start > ms) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("direct invites (CORD-05 §6)", () => {
  it("round-trips build → seal → wrap → unwrap → parse", async () => {
    const inviterSk = generateSecretKey();
    const inviterPk = getPublicKey(inviterSk);
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);

    const bundle = makeBundle();
    const rumor = buildDirectInviteRumor(bundle, inviterPk);
    const seal = await sealDirectInvite(rumor, recipientPk, rawSigner(inviterSk));
    expect(seal.kind).toBe(13);
    expect(seal.pubkey).toBe(inviterPk);

    const wrap = wrapDirectInvite(seal, recipientPk);
    expect(wrap.kind).toBe(KIND_WRAP);
    // Classic NIP-59: ephemeral author, fixed recipient — plus the k index hint.
    expect(wrap.pubkey).not.toBe(inviterPk);
    expect(wrap.tags).toContainEqual(["p", recipientPk]);
    expect(wrap.tags).toContainEqual(["k", String(KIND_DIRECT_INVITE)]);
    // NIP-59 backdating: never in the future.
    expect(wrap.created_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));

    const unwrapped = await unwrapDirectInvite(wrap, rawSigner(recipientSk));
    expect(unwrapped).toBeDefined();
    expect(unwrapped!.sender).toBe(inviterPk);

    const parsed = parseDirectInviteRumor(unwrapped!.rumor.kind, unwrapped!.rumor.content);
    expect(parsed).toBeDefined();
    expect(parsed!.community_id).toBe(bundle.community_id);
    expect(parsed!.name).toBe("Test community");
  });

  it("stamps a NIP-40 expiration on the wrap when the bundle expires", async () => {
    const inviterSk = generateSecretKey();
    const recipientPk = getPublicKey(generateSecretKey());
    const expiresAtMs = Date.now() + 86_400_000;
    const rumor = buildDirectInviteRumor(makeBundle({ expires_at: expiresAtMs }), getPublicKey(inviterSk));
    const seal = await sealDirectInvite(rumor, recipientPk, rawSigner(inviterSk));
    const wrap = wrapDirectInvite(seal, recipientPk, { expiresAtMs });
    expect(wrap.tags).toContainEqual(["expiration", String(Math.floor(expiresAtMs / 1000))]);
  });

  it("rejects a rumor whose claimed author differs from the seal's signer", async () => {
    const inviterSk = generateSecretKey();
    const impostorPk = getPublicKey(generateSecretKey());
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);

    // The rumor claims someone else sent it; the seal is signed by the inviter.
    const rumor = buildDirectInviteRumor(makeBundle(), impostorPk);
    const seal = await sealDirectInvite(rumor, recipientPk, rawSigner(inviterSk));
    const wrap = wrapDirectInvite(seal, recipientPk);
    expect(await unwrapDirectInvite(wrap, rawSigner(recipientSk))).toBeUndefined();
  });

  it("refuses a bundle whose owner does not reproduce its community_id", () => {
    const forged = makeBundle({ owner: bytesToHex(random32()) });
    expect(parseDirectInviteRumor(KIND_DIRECT_INVITE, JSON.stringify(forged))).toBeUndefined();
  });

  it("gates on the rumor kind — the outer k tag was only ever a hint", () => {
    expect(parseDirectInviteRumor(9, JSON.stringify(makeBundle()))).toBeUndefined();
  });

  it("tracks expiry without refusing to parse (a parked invite still renders)", () => {
    const expired = makeBundle({ expires_at: Date.now() - 1000 });
    const parsed = parseDirectInviteRumor(KIND_DIRECT_INVITE, JSON.stringify(expired));
    expect(parsed).toBeDefined();
    expect(directInviteExpired(parsed!)).toBe(true);
    expect(directInviteExpired(makeBundle())).toBe(false);
  });
});

describe("direct-invite inbox store", () => {
  async function makeUnwrapped() {
    const inviterSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);
    const bundle = makeBundle();
    const rumor = buildDirectInviteRumor(bundle, getPublicKey(inviterSk));
    const seal = await sealDirectInvite(rumor, recipientPk, rawSigner(inviterSk));
    const wrap = wrapDirectInvite(seal, recipientPk);
    const unwrapped = (await unwrapDirectInvite(wrap, rawSigner(recipientSk)))!;
    return { wrap, unwrapped, bundle, recipientPk, inviterPk: getPublicKey(inviterSk) };
  }

  it("round-trips an unwrapped invite through the codec", async () => {
    const { wrap, unwrapped, inviterPk } = await makeUnwrapped();

    const stored = unwrappedToStored(wrap, unwrapped);
    expect(stored.id).toBe(wrap.id);
    expect(stored.kind).toBe(KIND_DIRECT_INVITE);
    expect(stored.pubkey).toBe(inviterPk);
    // The tenant names the account, so no recipient tag is written any more.
    expect(stored.tags.some((t) => t[0] === "p")).toBe(false);

    const back = storedToInvite(stored);
    expect(back.wrapId).toBe(wrap.id);
    expect(back.sender).toBe(inviterPk);
    expect(back.rumor.content).toBe(unwrapped.rumor.content);
    expect(
      back.rumor.tags.some((t) => t[0] === "wrap" || t[0] === "sender" || t[0] === "wrapts"),
    ).toBe(false);
  });

  it("persists and queries invites without re-decrypting", async () => {
    const { wrap, unwrapped, bundle, recipientPk } = await makeUnwrapped();
    writeStoredInvites(recipientPk, [{ wrap: wrap as NostrEvent, unwrapped }]);
    const got = await eventually(
      () => queryStoredInvites(recipientPk),
      (r) => r.some((i) => i.wrapId === wrap.id),
    );
    const mine = got.find((i) => i.wrapId === wrap.id)!;
    expect(JSON.parse(mine.rumor.content).community_id).toBe(bundle.community_id);
  });

  it("recovers invites left in the pre-tenant shared database", async () => {
    const { wrap, unwrapped, recipientPk } = await makeUnwrapped();

    // A record written the old way: the shared database, scoped by `#p`. The
    // sync cursor is already past this wrap, so if the migration drops it the
    // invite is gone for good — nothing would ever refetch it.
    const legacy = new NIndexedDB("armada-concord-invites");
    await legacy.event({
      ...unwrappedToStored(wrap as NostrEvent, unwrapped),
      tags: [...unwrappedToStored(wrap as NostrEvent, unwrapped).tags, ["p", recipientPk]],
      sig: "",
    });
    await legacy.close();

    const got = await eventually(
      () => queryStoredInvites(recipientPk),
      (r) => r.some((i) => i.wrapId === wrap.id),
    );
    expect(got.find((i) => i.wrapId === wrap.id)!.sender).toBe(unwrapped.sender);
  });

  it("scopes reads to the recipient — another account never sees the invite", async () => {
    const { wrap, unwrapped, recipientPk } = await makeUnwrapped();
    const otherPk = getPublicKey(generateSecretKey());
    writeStoredInvites(recipientPk, [{ wrap: wrap as NostrEvent, unwrapped }]);
    // The recipient reads it back…
    await eventually(() => queryStoredInvites(recipientPk), (r) => r.some((i) => i.wrapId === wrap.id));
    // …but a different logged-in account never does (the leak this guards).
    const forOther = await queryStoredInvites(otherPk);
    expect(forOther.some((i) => i.wrapId === wrap.id)).toBe(false);
  });

  it("cursor resumes a backdate window behind the newest wrap scanned", async () => {
    const pubkey = "cursor-test-" + getPublicKey(generateSecretKey());
    expect(await inviteInboxSince(pubkey)).toBe(0); // cold cache → full scan

    const newest = 10_000_000;
    await advanceInviteInboxCursor(pubkey, newest);
    // Direct-invite wraps DO backdate (NIP-59), so the resume floor rewinds.
    expect(await inviteInboxSince(pubkey)).toBe(newest - WRAP_BACKDATE_SECS);

    // Monotonic: an older value never regresses the cursor.
    await advanceInviteInboxCursor(pubkey, newest - 500);
    expect(await inviteInboxSince(pubkey)).toBe(newest - WRAP_BACKDATE_SECS);
  });
});

describe("catch-up classification (isCatchUpBundle)", () => {
  const held = { rootEpoch: 3, channelEpochs: new Map([["aa", 2]]) };
  const ch = (id: string, epoch: number) => ({ id, key: "1".repeat(64), epoch, name: "c" });

  it("a fresher root epoch is a catch-up regardless of channels", () => {
    expect(isCatchUpBundle(held, { root_epoch: 4, channels: [] })).toBe(true);
  });

  it("a same-epoch vend carrying a channel key the member lacks is a catch-up", () => {
    // The exact field bug: a role-gate key vend rides the SAME root epoch and
    // was skipped as "already a member", so the key never arrived.
    expect(isCatchUpBundle(held, { root_epoch: 3, channels: [ch("bb", 0)] })).toBe(true);
    // A higher CHANNEL epoch for a held channel also qualifies (post-rotation vend).
    expect(isCatchUpBundle(held, { root_epoch: 3, channels: [ch("aa", 3)] })).toBe(true);
  });

  it("a bundle carrying a channel key I was CUT from is not a vend", () => {
    // Cut out of "bb" at channel epoch 2: an old bundle holding bb@0 is the
    // access that was revoked, so it must not park as a fresh key.
    const cut = { rootEpoch: 3, channelEpochs: new Map<string, number>(), channelCuts: new Map([["bb", 2]]) };
    expect(isCatchUpBundle(cut, { root_epoch: 3, channels: [ch("bb", 0)] })).toBe(false);
    // A key at/above the cut epoch is a genuine re-admission.
    expect(isCatchUpBundle(cut, { root_epoch: 3, channels: [ch("bb", 2)] })).toBe(true);
  });

  it("same-epoch bundles with nothing new, stale roots, and non-members never park", () => {
    expect(isCatchUpBundle(held, { root_epoch: 3, channels: [ch("aa", 2)] })).toBe(false);
    expect(isCatchUpBundle(held, { root_epoch: 2, channels: [ch("bb", 0)] })).toBe(false);
    expect(isCatchUpBundle(undefined, { root_epoch: 9, channels: [ch("bb", 0)] })).toBe(false);
  });
});
