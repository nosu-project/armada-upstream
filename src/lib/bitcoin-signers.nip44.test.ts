// @vitest-environment node
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip44 } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";

import { NSecSignerBtc } from "./bitcoin-signers";

describe("NSecSignerBtc NIP-44", () => {
  it("round-trips with a peer, and derives a recurring peer's conversation key twice at most", async () => {
    const mine = generateSecretKey();
    const peer = generateSecretKey();
    const signer = new NSecSignerBtc(mine);
    const peerPk = getPublicKey(peer);

    const spy = vi.spyOn(nip44.v2.utils, "getConversationKey");
    for (let i = 0; i < 5; i++) {
      const fromPeer = nip44.v2.encrypt(`hi ${i}`, nip44.v2.utils.getConversationKey(peer, getPublicKey(mine)));
      expect(await signer.nip44.decrypt(peerPk, fromPeer)).toBe(`hi ${i}`);
    }
    // Five from the test's own encrypts, and only two from the signer: the
    // first sighting, then the admitting second — every later one is a hit.
    expect(spy.mock.calls.filter(([sk]) => sk !== peer)).toHaveLength(2);

    const toPeer = await signer.nip44.encrypt(peerPk, "back");
    expect(nip44.v2.decrypt(toPeer, nip44.v2.utils.getConversationKey(peer, getPublicKey(mine)))).toBe("back");
    spy.mockRestore();
  });
});
