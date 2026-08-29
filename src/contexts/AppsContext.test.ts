import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { appScopeKey, type AppScope } from "@/contexts/AppsContext";
import { dmConvKey, dmConvPeers } from "@/lib/nip17/protocol";

const alice = getPublicKey(generateSecretKey());
const bob = getPublicKey(generateSecretKey());

/**
 * A DM app scope names a CONVERSATION, not a peer.
 *
 * Two places spell it: the launch card gets `ChatScopeContext`, and the stage
 * host gets its own `<AppStageSlot scope>`. `appScopeKey` is what decides they
 * are the same session, so a scope that can be built from either a conversation
 * key or one participant of it has a group case where the two disagree — and
 * the app then portals into a slot that was never registered. The key is also
 * the NIP-44 recipient further down (`useDmAppSync` → `sealDmRumor`), where a
 * comma-joined value is not a pubkey at all.
 */
describe("appScopeKey for a DM", () => {
  it("is the conversation key, which for a 1:1 is the bare peer", () => {
    // Load-bearing equivalence, the same one `dmConvKey` rests on: a 1:1 scope
    // key is byte-identical to the single-pubkey spelling, so no existing
    // session is re-named by scoping on the conversation.
    const scope: AppScope = { kind: "dm", conversation: dmConvKey([alice]) };
    expect(appScopeKey(scope)).toBe(`dm|${alice}`);
  });

  it("names one session for a group, whichever surface builds it", () => {
    const conversation = dmConvKey([alice, bob].sort());
    const card: AppScope = { kind: "dm", conversation };
    const stage: AppScope = { kind: "dm", conversation };
    expect(appScopeKey(stage)).toBe(appScopeKey(card));
    // And the key still decodes to the participants a wrap has to be minted
    // for, which is what makes it usable as more than an opaque id.
    expect(dmConvPeers(conversation)).toEqual([alice, bob].sort());
  });

  it("keeps two conversations apart even when they share a participant", () => {
    const group = appScopeKey({ kind: "dm", conversation: dmConvKey([alice, bob].sort()) });
    const oneToOne = appScopeKey({ kind: "dm", conversation: dmConvKey([alice]) });
    expect(group).not.toBe(oneToOne);
  });
});
