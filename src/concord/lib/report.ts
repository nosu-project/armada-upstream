/**
 * Concord reports — a NIP-56 report giftwrapped to the Control Plane address.
 *
 * A room has no relay operator to appeal to and no plaintext anywhere, so a
 * report has to travel as ciphertext addressed to the people who can act on it.
 * The Control Plane's signer pubkey (`control_pk`) is exactly that audience:
 * every member holds it (it is delivered with the join material), and only
 * staff can derive the matching secret from `control_root` (CORD-02 §2), which
 * is handed out on promotion and never otherwise. So a member can address staff
 * without holding anything staff-only, and no other member can read what they
 * sent — including the person being reported.
 *
 *   wrap(1059, ephemeral author, ["p", control_pk], ["k", "1984"])
 *     └ seal(13, signed by the reporter's REAL key)
 *         └ rumor(1984, NIP-56 tags + the reporter's words)
 *
 * This is a STANDARD NIP-59 giftwrap, not the reversed CORD-01 stream wrap, for
 * the same reason a Direct Invite is one (CORD-05 §6): it is addressed to a
 * party, not published at a stream. It is deliberately NOT stream traffic —
 * a report is not a plane, claims no kind in `PLANE_RULES`, and is never stored
 * as a rumor. Control Plane wraps are AUTHORED by `control_pk` and carry a
 * random ephemeral `p`; a report is the mirror image (ephemeral author,
 * `control_pk` in the `p` tag), so the two can never be mistaken for each other
 * even before the outer `k` tag narrows the query.
 *
 * A LEGACY pre-split epoch has no `control_pk` — its plane is one key every
 * member holds — so there is no staff-only audience to address and reporting is
 * simply unavailable there (see `reportDestination`).
 */

import { getConversationKey, decrypt as nip44Decrypt, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";

import { controlSignerGroupKey } from "@/concord/lib/derive";
import { KIND_WRAP } from "@/concord/lib/kinds";
import { KIND_NIP59_SEAL } from "@/concord/lib/directInvite";
import type { Community } from "@/concord/lib/types";
import { buildReportTags, KIND_REPORT, type ReportReason, type ReportTarget } from "@/lib/report";

/** NIP-59: outer timestamps are tweaked into the past, up to two days. */
const MAX_BACKDATE_SECS = 2 * 24 * 60 * 60;

function tweakedPast(): number {
  return Math.floor(Date.now() / 1000) - Math.floor(Math.random() * MAX_BACKDATE_SECS);
}

/** The signer surface a report send needs (every Concord-capable login). */
export interface ReportSigner {
  signEvent(template: EventTemplate): Promise<NostrEvent>;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
  };
}

/** The unsigned kind-1984 rumor: the report, claimed by the reporter. */
export interface ReportRumor {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
  pubkey: string;
}

// ── Sending ──────────────────────────────────────────────────────────────────

/** Build the kind-1984 rumor: NIP-56 tags plus whatever the reporter wrote. */
export function buildReportRumor(
  target: ReportTarget,
  reason: ReportReason,
  comment: string,
  reporterPubkey: string,
): ReportRumor {
  return {
    kind: KIND_REPORT,
    content: comment,
    tags: buildReportTags(target, reason),
    created_at: Math.floor(Date.now() / 1000),
    pubkey: reporterPubkey,
  };
}

/**
 * Seal the rumor with the reporter's REAL identity — the seal's verified npub
 * is what tells a moderator who raised the report, and is the only thing
 * stopping a member from flooding the queue under invented names.
 */
export async function sealReport(
  rumor: ReportRumor,
  controlPk: string,
  signer: ReportSigner,
): Promise<NostrEvent> {
  if (!signer.nip44) throw new Error("This signer can't send reports (NIP-44 unsupported).");
  return signer.signEvent({
    kind: KIND_NIP59_SEAL,
    content: await signer.nip44.encrypt(controlPk, JSON.stringify(rumor)),
    tags: [],
    created_at: tweakedPast(),
  });
}

/**
 * Wrap a signed seal for the Control Plane under a single-use ephemeral key.
 * The outer `k` tag is what makes the moderator queue one indexed REQ rather
 * than a decrypt of everything ever addressed to the plane — a hint, never
 * authority: a report is whatever unwraps to a kind-1984 rumor.
 */
export function wrapReport(seal: NostrEvent, controlPk: string): NostrEvent {
  const ephemeralSk = generateSecretKey();
  return finalizeEvent(
    {
      kind: KIND_WRAP,
      content: nip44Encrypt(JSON.stringify(seal), getConversationKey(ephemeralSk, controlPk)),
      tags: [
        ["p", controlPk],
        ["k", String(KIND_REPORT)],
      ],
      created_at: tweakedPast(),
    },
    ephemeralSk,
  );
}

// ── Receiving (staff only) ───────────────────────────────────────────────────

/**
 * The current epoch's Control Plane secret, or undefined for anyone who isn't
 * staff of a split epoch. This is the read key for the report queue, and
 * holding it IS the permission — there is no separate bit to check.
 *
 * A held `control_root` that doesn't derive to the held `control_pk` is corrupt
 * state, not a key, and yields undefined rather than a wrong conversation key
 * (mirrors `controlStreamOf`'s fail-closed check).
 */
export function reportInboxSecret(community: Community): Uint8Array | undefined {
  if (!community.controlPk || !community.controlRoot) return undefined;
  const signer = controlSignerGroupKey(community.controlRoot, community.id, community.rootEpoch);
  return signer.pk === community.controlPk ? signer.sk : undefined;
}

/** An unwrapped report: the inner rumor plus its seal-verified reporter. */
export interface UnwrappedReport {
  /** Gift-wrap event id — the stable key and dedup handle. */
  wrapId: string;
  /** The seal's author — the verified reporter. */
  reporter: string;
  rumor: ReportRumor;
}

/**
 * Unwrap a report addressed to the Control Plane, using the staff secret from
 * {@link reportInboxSecret}. Returns undefined for anything that isn't a
 * well-formed report this key can open — never throws, so a scan loop can skip
 * a foreign or malformed wrap.
 *
 * Both NIP-59 layers are peeled with RAW keys rather than a signer: the
 * conversation key is between the Control Plane secret and the counterparty,
 * and no signer will ever hold a derived group key. The rumor's claimed author
 * must equal the seal's — the standard anti-spoofing check, and here also what
 * makes "who reported this" answerable at all.
 */
export function unwrapReport(wrap: NostrEvent, controlSk: Uint8Array): UnwrappedReport | undefined {
  if (wrap.kind !== KIND_WRAP) return undefined;
  try {
    const seal = JSON.parse(
      nip44Decrypt(wrap.content, getConversationKey(controlSk, wrap.pubkey)),
    ) as NostrEvent;
    if (seal.kind !== KIND_NIP59_SEAL) return undefined;

    const rumor = JSON.parse(
      nip44Decrypt(seal.content, getConversationKey(controlSk, seal.pubkey)),
    ) as ReportRumor;
    if (rumor.kind !== KIND_REPORT) return undefined;
    if (rumor.pubkey !== seal.pubkey) return undefined;

    return { wrapId: wrap.id, reporter: seal.pubkey, rumor };
  } catch {
    return undefined;
  }
}

/** What a report points at: the accused, the message (if any), and the reason. */
export interface ReportSubject {
  pubkey?: string;
  eventId?: string;
  reason?: string;
}

/** Read a report rumor's NIP-56 tags back into its subject. */
export function reportSubject(rumor: ReportRumor): ReportSubject {
  const e = rumor.tags.find(([name]) => name === "e");
  const p = rumor.tags.find(([name]) => name === "p");
  return {
    pubkey: p?.[1],
    eventId: e?.[1],
    // The reason rides whichever tag names the thing being judged (NIP-56).
    reason: e?.[2] ?? p?.[2],
  };
}
