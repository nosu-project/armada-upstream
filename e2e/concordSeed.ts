// Browser-side seed harness for a populated Concord community, used by
// `scripts/perf-profile.mjs`.
//
// Mints a real community (CORD-01 ids and keys), writes its genesis control
// editions — sealed and wrapped exactly as `publishEdition` does, then opened
// and stored through the production `writeOpened` — and fills its channels
// with chat rumors through `writeRumors`, the writer the decode path feeds. The
// viewer's membership goes where `useCommunityList` reads it: the folded cache
// AND a real kind-33302 fragment in `main`, since without the fragment the
// list query can settle empty before the folded cache is read.
//
// Nothing here touches a relay. The community names an unroutable relay, and
// the harness answers whatever the app sends it.
import { bytesToHex } from "@noble/hashes/utils";
import { finalizeEvent, nip44 } from "nostr-tools";

import { mintCommunity } from "@/concord/lib/community";
import { toJoinMaterial, communityListFoldKey, type CommunityList } from "@/concord/lib/communityList";
import { buildChannelEdition, buildMetadataEdition, currentControlWriteGroup, sealEdition } from "@/concord/lib/control";
import { KIND_COMMUNITY_LIST_FRAG } from "@/concord/lib/kinds";
import { fragment, serializeFragList } from "@/concord/lib/listFrag";
import { writeOpened, writeRumors } from "@/concord/lib/rumorStore";
import { buildRumor, channelBindingTags, openWrap } from "@/concord/lib/stream";
import { writeFolded } from "@/lib/foldedCache";
import { appEventStore } from "@/lib/db/mainEventStore";

import type { OpenedChat } from "@/concord/lib/chat";

export interface ConcordSeedPayload {
  /** The viewer's secret key, hex. They own the community. */
  sk: string;
  /** Other members' pubkeys, hex — the authors that aren't the viewer. */
  others: string[];
  /** Messages per channel; the first channel is the big one. */
  channelSizes: number[];
  /** Line pool; varied so the flood heuristic sees conversation, not spam. */
  lines: string[];
}

export interface ConcordSeedResult {
  communityId: string;
  channelIds: string[];
}

declare global {
  interface Window {
    __armadaSeedConcord?: (payload: ConcordSeedPayload) => Promise<ConcordSeedResult>;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function random32(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

async function seed(p: ConcordSeedPayload): Promise<ConcordSeedResult> {
  const sk = hexToBytes(p.sk);
  const signer = { signEvent: async (t: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(t, sk) };
  const self = finalizeEvent({ kind: 1, content: "", tags: [], created_at: 0 }, sk).pubkey;
  localStorage.setItem(`armada:relay-prompt-shown:${self}`, "1");

  const { community, generalChannelId } = mintCommunity("Perf Harbor", self, ["wss://relay.invalid"]);
  const control = currentControlWriteGroup(community);
  const channelIds = [generalChannelId, ...p.channelSizes.slice(1).map(() => random32())];

  // Genesis: the metadata edition, then one edition per channel.
  const genesis = [
    buildMetadataEdition(community.id, { name: community.name, relays: community.relays }, { actorPubkey: self, version: 1n }),
    ...channelIds.map((id, i) =>
      buildChannelEdition(id, { name: i === 0 ? "general" : `channel-${i}`, private: false }, { actorPubkey: self, version: 1n }),
    ),
  ];
  const opened = await Promise.all(genesis.map(async (r) => openWrap(await sealEdition(r, control, signer), control)));
  await writeOpened(community.idHex, opened, "control", { refounded: false });

  // Chat: spread over ~90 days, mostly the viewer (exempt from flood folding).
  const nowMs = Date.now() - 60_000;
  const span = 90 * 24 * 3600 * 1000;
  for (const [ci, size] of p.channelSizes.entries()) {
    const channelIdHex = bytesToHex(channelIds[ci]);
    const batch: OpenedChat[] = [];
    for (let i = 0; i < size; i++) {
      const author = i % 3 === 0 || p.others.length === 0 ? self : p.others[i % p.others.length];
      const ms = Math.floor(nowMs - span + (span * i) / size);
      const content = `${p.lines[(i + ci) % p.lines.length]} (#${i})`;
      const rumor = buildRumor({ kind: 9, content, tags: channelBindingTags(channelIdHex, 0n), pubkey: author, ms });
      batch.push({
        rumorId: rumor.id,
        author,
        kind: 9,
        content,
        tags: rumor.tags,
        ms,
        createdAt: rumor.created_at,
        channelIdHex,
        epoch: 0n,
      });
    }
    for (let i = 0; i < batch.length; i += 500) await writeRumors(community.idHex, batch.slice(i, i + 500));
  }

  // Membership: the folded cache the list boots from, and a real fragment.
  const jm = toJoinMaterial(community, { relays: community.relays });
  const list: CommunityList = {
    entries: [{ community_id: community.idHex, seed: jm, current: jm, added_at: Date.now() }],
    tombstones: [],
  };
  await writeFolded(communityListFoldKey(self), { event: null, list });
  const [frag] = fragment(list);
  const content = nip44.v2.encrypt(serializeFragList(frag), nip44.v2.utils.getConversationKey(sk, self));
  const event = finalizeEvent(
    { kind: KIND_COMMUNITY_LIST_FRAG, tags: [["d", "0"]], content, created_at: Math.floor(Date.now() / 1000) },
    sk,
  );
  await (await appEventStore()).event(event);

  return { communityId: community.idHex, channelIds: channelIds.map(bytesToHex) };
}

window.__armadaSeedConcord = seed;
