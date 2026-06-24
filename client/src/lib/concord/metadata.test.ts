import { bytesToHex } from "@noble/hashes/utils.js";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  buildBanlistEditionUnsigned,
  buildChannelMetadataEditionUnsigned,
  buildCommunityRootEditionUnsigned,
  buildRoleEditionUnsigned,
  buildGrantEditionUnsigned,
  buildDissolvedEditionUnsigned,
  foldBanlist,
  foldMetadata,
  foldRoster,
  isDissolved,
  sealControlEdition,
  sealDissolvedEdition,
} from "@/lib/concord/control";
import { signEdition } from "@/lib/concord/edition";
import { communityMetadataOf } from "@/lib/concord/metadata";
import { buildOwnerAttestationUnsigned, signOwnerAttestation } from "@/lib/concord/owner";
import { adminRole } from "@/lib/concord/roles";
import { createCommunity } from "@/lib/concord/types";

import type { NostrEvent } from "@nostrify/nostrify";

// Genesis control plane + metadata fold (Phase 1 of Vector parity).

function mintWithOwner() {
  const ownerSk = generateSecretKey();
  const ownerHex = getPublicKey(ownerSk);
  const community = createCommunity("HQ", "general", ["wss://r1", "wss://r2"]);
  community.ownerAttestation = JSON.stringify(
    signOwnerAttestation(buildOwnerAttestationUnsigned(bytesToHex(community.id)), ownerSk),
  );
  return { ownerSk, ownerHex, community };
}

/** Seal an owner-signed control edition the way the genesis publisher does. */
function sealAs(
  sk: Uint8Array,
  unsigned: { kind: number; content: string; tags: string[][]; created_at: number },
  serverRoot: Uint8Array,
  communityId: Uint8Array,
): NostrEvent {
  const inner = signEdition(unsigned, sk);
  return sealControlEdition(inner, serverRoot, communityId, 0n);
}

describe("genesis control plane + metadata fold", () => {
  it("folds the GroupRoot + channel metadata an owner publishes at mint", () => {
    const { ownerSk, ownerHex, community } = mintWithOwner();
    const now = 1700000000;

    const outers = [
      sealAs(
        ownerSk,
        buildCommunityRootEditionUnsigned({
          communityId: community.id,
          metadata: communityMetadataOf(community),
          version: 1n,
          createdAtSecs: now,
        }),
        community.serverRootKey,
        community.id,
      ),
      sealAs(ownerSk, buildRoleEditionUnsigned({ role: adminRole("a".repeat(64)), version: 1n, createdAtSecs: now }), community.serverRootKey, community.id),
      sealAs(
        ownerSk,
        buildChannelMetadataEditionUnsigned({
          channelId: community.channels[0].id,
          metadata: { name: "general" },
          version: 1n,
          createdAtSecs: now,
        }),
        community.serverRootKey,
        community.id,
      ),
    ];

    const roster = foldRoster(outers, community.serverRootKey, community.id, community.ownerAttestation);
    expect(roster.ownerHex).toBe(ownerHex);

    const meta = foldMetadata(outers, community.serverRootKey, community.id, roster.roster, roster.ownerHex);
    expect(meta.root?.name).toBe("HQ");
    expect(meta.channelNames.get(bytesToHex(community.channels[0].id))).toBe("general");
  });

  it("applies an owner's later GroupRoot edit (version chain) over the genesis root", () => {
    const { ownerSk, community } = mintWithOwner();
    const now = 1700000000;

    const genesis = sealAs(
      ownerSk,
      buildCommunityRootEditionUnsigned({
        communityId: community.id,
        metadata: communityMetadataOf(community),
        version: 1n,
        createdAtSecs: now,
      }),
      community.serverRootKey,
      community.id,
    );

    // Chain v2 off v1's folded head hash (as the real updateMetadata flow does).
    const roster1 = foldRoster([genesis], community.serverRootKey, community.id, community.ownerAttestation);
    const meta1 = foldMetadata([genesis], community.serverRootKey, community.id, roster1.roster, roster1.ownerHex);
    const head = meta1.heads.get(bytesToHex(community.id))!;
    expect(head.version).toBe(1n);

    const renamed = sealAs(
      ownerSk,
      buildCommunityRootEditionUnsigned({
        communityId: community.id,
        metadata: { ...communityMetadataOf(community), name: "Renamed HQ", description: "now with a topic" },
        version: head.version + 1n,
        prevHash: head.hash,
        createdAtSecs: now + 10,
      }),
      community.serverRootKey,
      community.id,
    );

    const roster = foldRoster([genesis, renamed], community.serverRootKey, community.id, community.ownerAttestation);
    const meta = foldMetadata([genesis, renamed], community.serverRootKey, community.id, roster.roster, roster.ownerHex);
    expect(meta.root?.name).toBe("Renamed HQ");
    expect(meta.root?.description).toBe("now with a topic");
  });

  it("drops a metadata edit from an unauthorized (non-owner, ungranted) signer", () => {
    const { ownerSk, community } = mintWithOwner();
    const strangerSk = generateSecretKey();
    const now = 1700000000;

    const genesis = sealAs(
      ownerSk,
      buildCommunityRootEditionUnsigned({
        communityId: community.id,
        metadata: communityMetadataOf(community),
        version: 1n,
        createdAtSecs: now,
      }),
      community.serverRootKey,
      community.id,
    );
    // A stranger tries to overwrite the GroupRoot at a higher version.
    const forged = sealAs(
      strangerSk,
      buildCommunityRootEditionUnsigned({
        communityId: community.id,
        metadata: { ...communityMetadataOf(community), name: "HACKED" },
        version: 2n,
        createdAtSecs: now + 10,
      }),
      community.serverRootKey,
      community.id,
    );

    const roster = foldRoster([genesis, forged], community.serverRootKey, community.id, community.ownerAttestation);
    const meta = foldMetadata([genesis, forged], community.serverRootKey, community.id, roster.roster, roster.ownerHex);
    // The forged head folds at the version-chain level, but metadata authority
    // rejects it (stranger holds no MANAGE_METADATA) → no root is surfaced.
    expect(meta.root?.name).not.toBe("HACKED");
  });
});

describe("encrypted community image", () => {
  it("encrypts then decrypts back to the original bytes (integrity verified)", async () => {
    const { encryptImage, decryptImageToObjectURL } = await import("@/lib/concord/communityImage");
    const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // jsdom's Blob lacks arrayBuffer(); use a minimal stub the encoder accepts.
    const file = { arrayBuffer: async () => original.buffer.slice(0) } as unknown as Blob;

    const { ciphertext, key, nonce, hash, ext } = await encryptImage(file, "png");
    // Ciphertext must differ from plaintext (it's actually encrypted).
    expect([...ciphertext]).not.toEqual([...original]);

    // Stub fetch to serve the ciphertext back from the recorded "url".
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(ciphertext.buffer, { status: 200 })) as typeof fetch;
    // Stub object URLs (jsdom lacks createObjectURL).
    const realCreate = URL.createObjectURL;
    const captured: Blob[] = [];
    URL.createObjectURL = ((b: Blob) => {
      captured.push(b);
      return "blob:stub";
    }) as typeof URL.createObjectURL;
    try {
      // Succeeds only if AES-GCM decrypt + the plaintext SHA-256 integrity
      // check both pass — i.e. the round-trip recovered the exact bytes.
      const url = await decryptImageToObjectURL({ url: "https://host/blob", key, nonce, hash, ext });
      expect(url).toBe("blob:stub");
      expect(captured).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
      URL.createObjectURL = realCreate;
    }
  });
});

describe("banlist fold (vsk=4)", () => {
  it("an owner's ban folds; an unauthorized ban is ignored", () => {
    const { ownerSk, community } = mintWithOwner();
    const strangerSk = generateSecretKey();
    const target = "cc".repeat(32);
    const now = 1700000000;

    const ownerBan = sealAs(
      ownerSk,
      buildBanlistEditionUnsigned({ communityId: community.id, banned: [target], version: 1n, createdAtSecs: now }),
      community.serverRootKey,
      community.id,
    );
    const roster = foldRoster([ownerBan], community.serverRootKey, community.id, community.ownerAttestation);
    const banlist = foldBanlist([ownerBan], community.serverRootKey, community.id, roster.roster, roster.ownerHex);
    expect(banlist.banned.has(target)).toBe(true);
    expect(banlist.head?.version).toBe(1n);

    // A stranger (no BAN permission) trying to ban is dropped.
    const strangerBan = sealAs(
      strangerSk,
      buildBanlistEditionUnsigned({ communityId: community.id, banned: ["dd".repeat(32)], version: 2n, createdAtSecs: now + 5 }),
      community.serverRootKey,
      community.id,
    );
    const banlist2 = foldBanlist(
      [strangerBan],
      community.serverRootKey,
      community.id,
      roster.roster,
      roster.ownerHex,
    );
    expect(banlist2.banned.size).toBe(0);
  });

  it("an admin granted BAN can ban", () => {
    const { ownerSk, community } = mintWithOwner();
    const adminSk = generateSecretKey();
    const adminHex = getPublicKey(adminSk);
    const target = "cc".repeat(32);
    const now = 1700000000;
    const role = adminRole("a".repeat(64));

    const roleEd = sealAs(ownerSk, buildRoleEditionUnsigned({ role, version: 1n, createdAtSecs: now }), community.serverRootKey, community.id);
    const grantEd = sealAs(
      ownerSk,
      buildGrantEditionUnsigned({ communityId: community.id, grant: { member: adminHex, roleIds: [role.roleId] }, version: 1n, createdAtSecs: now }),
      community.serverRootKey,
      community.id,
    );
    const adminBan = sealAs(
      adminSk,
      buildBanlistEditionUnsigned({ communityId: community.id, banned: [target], version: 1n, createdAtSecs: now + 5 }),
      community.serverRootKey,
      community.id,
    );

    const outers = [roleEd, grantEd, adminBan];
    const roster = foldRoster(outers, community.serverRootKey, community.id, community.ownerAttestation);
    const banlist = foldBanlist(outers, community.serverRootKey, community.id, roster.roster, roster.ownerHex);
    expect(banlist.banned.has(target)).toBe(true);
  });
});

describe("dissolve (vsk=10)", () => {
  it("an owner's tombstone marks the community dissolved; a stranger's does not", () => {
    const { ownerSk, ownerHex, community } = mintWithOwner();
    const strangerSk = generateSecretKey();
    const now = 1700000000;

    const ownerTomb = sealDissolvedEdition(signEdition(buildDissolvedEditionUnsigned(community.id, now), ownerSk), community.id);
    expect(isDissolved([ownerTomb], community.id, ownerHex)).toBe(true);

    const strangerTomb = sealDissolvedEdition(
      signEdition(buildDissolvedEditionUnsigned(community.id, now), strangerSk),
      community.id,
    );
    expect(isDissolved([strangerTomb], community.id, ownerHex)).toBe(false);
  });
});
