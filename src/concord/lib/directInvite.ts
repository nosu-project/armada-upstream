/**
 * Concord Direct Invites — CORD-05 §6.
 *
 * A Direct Invite drops the link machinery entirely: when the invitee is a
 * known npub, the §1 `CommunityInvite` bundle giftwraps straight to them as a
 * STANDARD NIP-59 giftwrap (ephemeral wrap author, the recipient in the `p`
 * tag, a kind-13 seal signed by the inviter's REAL key — not the reversed
 * stream wrap of CORD-01). No coordinate, no token, nothing to fetch:
 *
 *   wrap(1059, ephemeral author, ["p", recipient], ["k", "3313"])
 *     └ seal(13, signed by the inviter)
 *         └ rumor(3313, content = the CommunityInvite bundle as JSON)
 *
 * The outer `k` tag is what makes invites INDEXED: a recipient looks up
 * exactly their invites — `{"kinds":[1059], "#p":[me], "#k":["3313"]}` —
 * instead of decrypting everything ever p-tagged at them (NIP-17's cost). The
 * tag is unsigned relay-visible bytes, a hint and never authority: an invite
 * is whatever unwraps to a kind-3313 rumor.
 *
 * A Direct Invite is a key handoff, not a standing door: unrevocable once
 * landed (regretting one is what Rekeys are for), absent from the Registry,
 * and it never flips the Community Public — which is precisely what lets a
 * Private Community grow by personal handoff, one npub at a time.
 *
 * Sending needs the abstract signer only (`signEvent` + `nip44.encrypt`), so
 * nsec, extension, and bunker logins can all invite; unwrapping likewise peels
 * the layers with `nip44.decrypt` (nostr-tools' nip59 helpers need a raw key,
 * which NIP-07/NIP-46 signers never expose).
 */

import { getConversationKey, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";

import { validateBundle, type InviteBundle } from "@/concord/lib/invite";
import { KIND_DIRECT_INVITE, KIND_WRAP } from "@/concord/lib/kinds";

/** The standard NIP-59 seal kind (classic giftwrap — not a CORD-01 seal). */
export const KIND_NIP59_SEAL = 13;

/** NIP-59: outer timestamps are tweaked into the past, up to two days. */
const MAX_BACKDATE_SECS = 2 * 24 * 60 * 60;

function tweakedPast(): number {
  return Math.floor(Date.now() / 1000) - Math.floor(Math.random() * MAX_BACKDATE_SECS);
}

/** The signer surface a Direct Invite send needs (every Concord-capable login). */
export interface DirectInviteSigner {
  signEvent(template: EventTemplate): Promise<NostrEvent>;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

/** The unsigned kind-3313 rumor: the bundle whole, claimed by the inviter. */
export interface DirectInviteRumor {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
  pubkey: string;
}

// ── Sending ──────────────────────────────────────────────────────────────────

/** Build the kind-3313 rumor carrying the bundle as its content (CORD-05 §6). */
export function buildDirectInviteRumor(bundle: InviteBundle, inviterPubkey: string): DirectInviteRumor {
  return {
    kind: KIND_DIRECT_INVITE,
    content: JSON.stringify(bundle),
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
    pubkey: inviterPubkey,
  };
}

/**
 * Seal the rumor with the inviter's REAL identity (the seal's verified npub is
 * what proves who invited them) — one signer round-trip, NIP-44-encrypted to
 * the recipient, timestamp tweaked into the past per NIP-59.
 */
export async function sealDirectInvite(
  rumor: DirectInviteRumor,
  recipientPubkey: string,
  signer: DirectInviteSigner,
): Promise<NostrEvent> {
  if (!signer.nip44) throw new Error("This signer can't send direct invites (NIP-44 unsupported).");
  return signer.signEvent({
    kind: KIND_NIP59_SEAL,
    content: await signer.nip44.encrypt(recipientPubkey, JSON.stringify(rumor)),
    tags: [],
    created_at: tweakedPast(),
  });
}

/**
 * Wrap a signed seal for the recipient under a single-use ephemeral key. The
 * wrap carries what no Concord stream event may — identifying outer tags: the
 * recipient `p` and the indexing `k` (plus optional NIP-40 expiration matching
 * the bundle's `expires_at`, so relays can prune a stale handoff).
 */
export function wrapDirectInvite(
  seal: NostrEvent,
  recipientPubkey: string,
  opts?: { expiresAtMs?: number },
): NostrEvent {
  const ephemeralSk = generateSecretKey();
  const convKey = getConversationKey(ephemeralSk, recipientPubkey);
  const tags: string[][] = [
    ["p", recipientPubkey],
    ["k", String(KIND_DIRECT_INVITE)],
  ];
  if (opts?.expiresAtMs) tags.push(["expiration", String(Math.floor(opts.expiresAtMs / 1000))]);
  return finalizeEvent(
    {
      kind: KIND_WRAP,
      content: nip44Encrypt(JSON.stringify(seal), convKey),
      tags,
      created_at: tweakedPast(),
    },
    ephemeralSk,
  );
}

// ── Receiving ────────────────────────────────────────────────────────────────

/** An unwrapped giftwrap: the inner rumor plus its seal-verified sender. */
export interface UnwrappedInvite {
  rumor: DirectInviteRumor;
  /** The seal's author — the verified sender (the inviter). */
  sender: string;
}

/**
 * Unwrap a kind-1059 giftwrap addressed to the current user. Returns the inner
 * rumor + the verified sender, or undefined if it isn't a well-formed wrap this
 * signer can open. Never throws — a foreign/garbage wrap yields undefined so a
 * scan loop can skip it.
 *
 * The sender is the SEAL's author (kind 13), and the rumor must claim the same
 * pubkey — the standard NIP-59 anti-spoofing check (a wrap can't lie about who
 * sealed it without the seal author's key).
 */
export async function unwrapDirectInvite(
  giftWrap: NostrEvent,
  signer: Pick<DirectInviteSigner, "nip44">,
): Promise<UnwrappedInvite | undefined> {
  if (giftWrap.kind !== KIND_WRAP || !signer.nip44) return undefined;
  try {
    // Layer 1: decrypt the wrap with the ephemeral wrap author's pubkey → seal.
    const seal = JSON.parse(await signer.nip44.decrypt(giftWrap.pubkey, giftWrap.content)) as NostrEvent;
    if (seal.kind !== KIND_NIP59_SEAL) return undefined;

    // Layer 2: decrypt the seal with the seal author's pubkey → rumor.
    const rumor = JSON.parse(await signer.nip44.decrypt(seal.pubkey, seal.content)) as DirectInviteRumor;

    // Anti-spoofing: the rumor's claimed author must equal the seal's author.
    if (rumor.pubkey !== seal.pubkey) return undefined;

    return { rumor, sender: seal.pubkey };
  } catch {
    return undefined;
  }
}

/**
 * Parse + validate an unwrapped rumor as a Direct Invite bundle. The outer `k`
 * tag was only ever a hint — the rumor's kind is the authority here — and the
 * bundle validates exactly as a fetched one (bounds, self-certifying owner).
 * Expiry is deliberately NOT enforced here: a parked invite still renders past
 * `expires_at`; accepting refuses. Returns undefined for anything malformed.
 */
export function parseDirectInviteRumor(kind: number, content: string): InviteBundle | undefined {
  if (kind !== KIND_DIRECT_INVITE) return undefined;
  try {
    const bundle = JSON.parse(content) as InviteBundle;
    if (typeof bundle.community_id !== "string" || typeof bundle.name !== "string") return undefined;
    return validateBundle(bundle);
  } catch {
    return undefined;
  }
}

/** Whether a bundle's shelf life has run out (`expires_at` is unix ms). */
export function directInviteExpired(bundle: InviteBundle, nowMs = Date.now()): boolean {
  return typeof bundle.expires_at === "number" && nowMs > bundle.expires_at;
}

/** What an already-joined member currently holds, for catch-up classification. */
export interface HeldMembership {
  rootEpoch: number;
  /** The base access key currently held (hex). A catch-up may never change it. */
  communityRoot: string;
  /** The Control Plane signer pubkey currently held (hex), when this epoch has one. */
  controlPk?: string;
  /** channel id (hex) → held channel epoch. */
  channelEpochs: ReadonlyMap<string, number>;
  /**
   * channel id (hex) → the channel epoch whose rotation cut me out. A key
   * BELOW that epoch is the access I was revoked, not a vend: without this
   * floor, an old bundle still in my inbox would look like a fresh key for a
   * channel I no longer hold and quietly restore it.
   */
  channelCuts?: ReadonlyMap<string, number>;
}

/**
 * Compare two optional hex fields. A bundle is another client's document, and
 * CORD-01 says hex is lowercase while foreign input may not be — an unmatched
 * spelling here would read as a changed base and drop a legitimate vend.
 */
function hexEq(a: string | undefined, b: string | undefined): boolean {
  return a?.toLowerCase() === b?.toLowerCase();
}

/**
 * Is an incoming bundle for an already-joined community a CATCH-UP worth
 * parking (vs. noise to skip)? Exactly one shape qualifies: a bundle continuing
 * the SAME base the member already holds, carrying a private-channel key they
 * lack or hold at an older channel epoch — a role-gate key vend (CORD.md).
 *
 * It may never move the base. Nothing binds a bundle's `community_root` to its
 * `community_id`: the id self-certifies the OWNER (CORD-02 §1, A.4) and the root
 * is "deliberately not derived from" it (CORD-02 §2), so a hostile bundle can
 * carry a real community's id, owner and salt beside an attacker-chosen root and
 * still pass `validateBundle`. Accepting one for a community already held merges
 * it through the Community List's `freshest` (CORD-02 §8) — a rule written for
 * reconciling a member's OWN devices, whose input is a self-signed, self-encrypted
 * document, not a stranger's giftwrap — and relocates every future message the
 * member writes onto streams the attacker reads. The precondition is only
 * `(community_id, owner, owner_salt)`, which ride in every bundle and are not
 * revoked by removal, so any past link-holder retains it forever.
 *
 * The base advances by exactly one spec-sanctioned route, and it is not this
 * one: a CORD-06 §2 rekey blob, adopted only when its `prevcommit` proves the
 * rotation extends the very key already held. A member who slept through a
 * Refounding heals from that blob, parked at an address derived from the root
 * they still hold (CORD-08 §1) — so refusing base changes here strands nobody.
 * Consistent with CORD-05 §6: a Direct Invite "grants exactly what it carries".
 */
export function isCatchUpBundle(
  held: HeldMembership | undefined,
  bundle: Pick<InviteBundle, "root_epoch" | "channels" | "community_root" | "control_pk">,
): boolean {
  return catchUpChannelIds(held, bundle).length > 0;
}

/**
 * The private-channel ids (lowercase hex) a bundle would NEWLY contribute to an
 * already-joined member — the vend inside a catch-up. Empty when the bundle is
 * not a catch-up at all ({@link isCatchUpBundle} is exactly "non-empty").
 *
 * Split out because the adoption decision has to judge entitlement per
 * channel: a bundle that carries one key I'm owed beside one I'm not is not
 * adoptable as a whole, and only the channels it actually adds are the ones
 * whose entitlement matters.
 */
export function catchUpChannelIds(
  held: HeldMembership | undefined,
  bundle: Pick<InviteBundle, "root_epoch" | "channels" | "community_root" | "control_pk">,
): string[] {
  if (held === undefined) return [];
  // Same base, or it is not a catch-up at any epoch. `control_pk` rides along:
  // swapping it alone eclipses the member onto an attacker's Control Plane,
  // which CORD-05 §1 accepts only as self-harm by an inviter a JOINER chose.
  if (!hexEq(bundle.community_root, held.communityRoot)) return [];
  if (!hexEq(bundle.control_pk, held.controlPk)) return [];
  if (bundle.root_epoch !== held.rootEpoch) return [];
  // A bundle is another client's document: normalize its id spelling before
  // consulting the cut floor (CORD-01: hex is lowercase; foreign input may
  // not be, and an unmatched spelling here would re-park revoked access).
  const out: string[] = [];
  for (const c of bundle.channels) {
    const id = c.id.toLowerCase();
    const cut = held.channelCuts?.get(id);
    if (cut !== undefined && c.epoch < cut) continue; // revoked access, not a vend
    const heldEpoch = held.channelEpochs.get(id);
    if (heldEpoch === undefined || c.epoch > heldEpoch) out.push(id);
  }
  return out;
}

/**
 * What a Community List entry currently holds, in the shape the catch-up
 * classifier reads. Structural over the entry so the lib stays free of the
 * list module; every reader of an entry's held keys for this purpose goes
 * through here, so the two spellings of "what I hold" cannot drift.
 */
export function heldMembershipOf(entry: {
  current: {
    root_epoch: number;
    community_root: string;
    control_pk?: string;
    channels?: Array<{ id: string; epoch: number }>;
  };
  channel_cuts?: Array<{ id: string; epoch: number }>;
}): HeldMembership {
  const channels = Array.isArray(entry.current.channels) ? entry.current.channels : [];
  return {
    rootEpoch: entry.current.root_epoch,
    communityRoot: entry.current.community_root,
    ...(entry.current.control_pk ? { controlPk: entry.current.control_pk } : {}),
    // Lowercase keys: catchUpChannelIds normalizes the bundle side the same
    // way, so one channel is one entry whatever a foreign list copy's
    // spelling was.
    channelEpochs: new Map(channels.map((c) => [c.id.toLowerCase(), c.epoch])),
    channelCuts: new Map((entry.channel_cuts ?? []).map((c) => [c.id.toLowerCase(), c.epoch])),
  };
}
