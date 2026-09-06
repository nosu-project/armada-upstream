// Browser-side seed harness for the Flathub/store screenshots.
//
// It exists to boot the REAL routed app into a populated DM view with no relay
// and no network — the one view whose data can be faithfully seeded locally,
// because a DM thread is just decrypted NIP-17 rumors in ArmadaDB plus kind-0
// profiles in the `main` tenant (the Concord channel view would need the whole
// CORD-01/02/05 derivation stack, and the call view a live LiveKit room).
//
// The spec loads /e2e/screenshotSeed.html (dev-server only, never in a build),
// calls `window.__armadaSeed(payload)` to write the app's OWN ArmadaDB through
// the real writers — so the term policy derives the `conv:`/`convmsg:` index
// exactly as production does — then navigates to `/dm/<peer>` on the same
// origin, where the routed app reads the same IndexedDB back. Login state is
// separate: the spec sets `armada:login` in an init script before boot.
import { appEventStore } from "@/lib/db/mainEventStore";
import { writeDm17Rumors } from "@/lib/nip17/dm17Store";

import type { NostrRumor } from "@/lib/nostrRumor";
import type { OpenedDm } from "@/lib/nip17/protocol";

/** One decrypted DM the harness should persist into `dm17:<self>`. */
export interface SeedMessage {
  /** The rumor id (a real NIP-01 hash, computed spec-side). */
  rumorId: string;
  /** The message author's hex pubkey. */
  author: string;
  /** The conversation participants from the viewer's view (everyone but self). */
  peers: string[];
  /** `p` tags etc. — the bytes `dmPeersOf` re-derives the conversation from. */
  tags: string[][];
  content: string;
  createdAt: number;
  kind: number;
}

/** A kind-0 profile the harness should persist into `main`. */
export interface SeedProfile {
  rumorId: string;
  pubkey: string;
  createdAt: number;
  /** Already-stringified kind-0 content (`{ name, picture, about }`). */
  content: string;
}

export interface SeedPayload {
  /** The logged-in viewer's hex pubkey (the owner of the dm17 tenant). */
  self: string;
  profiles: SeedProfile[];
  messages: SeedMessage[];
  /** Optional extra rumors for `main` (e.g. the viewer's kind-3 follow list). */
  mainRumors?: NostrRumor[];
}

declare global {
  interface Window {
    __armadaSeed?: (payload: SeedPayload) => Promise<void>;
  }
}

async function seed(payload: SeedPayload): Promise<void> {
  // Best-effort opt-out of the one-time "restore your setup" recovery prompt:
  // a background empty-relay read finds no servers/settings for this account
  // and can redirect to the restore interstitial, covering the DM view we came
  // to capture. This marker does not reliably win the race on its own, so the
  // spec also dismisses the interstitial if it appears — don't drop that.
  localStorage.setItem(`armada:relay-prompt-shown:${payload.self}`, "1");

  const store = await appEventStore();

  // Profiles + any extra main-tenant rumors (follow list). Kind-0 needs no term
  // index and no relay scope, so it lands in `main` directly.
  for (const p of payload.profiles) {
    const rumor: NostrRumor = {
      id: p.rumorId,
      pubkey: p.pubkey,
      kind: 0,
      created_at: p.createdAt,
      tags: [],
      content: p.content,
    };
    await store.event(rumor);
  }
  for (const rumor of payload.mainRumors ?? []) {
    await store.event(rumor);
  }

  // DM rumors through the app's own writer, so the conversation-term index is
  // built by the production policy rather than hand-rolled.
  const opened: OpenedDm[] = payload.messages.map((m) => ({
    rumorId: m.rumorId,
    author: m.author,
    kind: m.kind,
    content: m.content,
    tags: m.tags,
    createdAt: m.createdAt,
    peers: m.peers,
    wrapId: "",
  }));
  await writeDm17Rumors(payload.self, opened);
}

window.__armadaSeed = seed;
