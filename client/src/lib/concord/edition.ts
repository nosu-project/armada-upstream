/**
 * Real-npub authority editions — ported from Vector's `community/edition.rs`.
 *
 * An authority change (Grant, RoleMetadata, Banlist, ...) is an inner event
 * signed by the ACTOR's own npub, carrying the entity id, a per-entity `version`,
 * and the previous edition's hash. That inner Schnorr signature IS the proof of
 * who acted; the roster decides whether they were allowed, and `version.fold`
 * decides which edition is current.
 */

import { hexToBytes } from "@noble/hashes/utils.js";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";

import { KIND_COMMUNITY_CONTROL } from "@/lib/concord/kinds";
import { toHex } from "@/lib/concord/types";
import { editionHash, type Edition } from "@/lib/concord/version";

const TAG_SUBKIND = "vsk";
const TAG_ENTITY = "eid";
const TAG_EVERSION = "ev";
const TAG_EPREV = "ep";
const TAG_VERSION = "v";
const TAG_AUTHORITY_CITATION = "vac";
const PROTOCOL_VERSION = "1";

/** The pinned authority an actor claims for an action. */
export interface AuthorityCitation {
  entityId: Uint8Array;
  version: bigint;
  editionHash: Uint8Array;
}

const HEX64 = /^[0-9a-f]{64}$/i;

export function citationToTag(c: AuthorityCitation): string[] {
  return [TAG_AUTHORITY_CITATION, toHex(c.entityId), c.version.toString(), toHex(c.editionHash)];
}

export function citationFromTags(tags: string[][]): AuthorityCitation | undefined {
  const t = tags.find((t) => t.length >= 4 && t[0] === TAG_AUTHORITY_CITATION);
  if (!t) return undefined;
  if (!HEX64.test(t[1]) || !HEX64.test(t[3])) return undefined;
  const version = Number(t[2]);
  if (!Number.isInteger(version) || version < 0) return undefined;
  return { entityId: hexToBytes(t[1]), version: BigInt(t[2]), editionHash: hexToBytes(t[3]) };
}

/** Build the unsigned inner edition event. Sign it with the ACTOR's real identity keys. */
export function buildEditionInner(opts: {
  vsk: string;
  entityId: Uint8Array;
  version: bigint;
  prevHash?: Uint8Array;
  content: string;
  createdAtSecs: number;
  authority?: AuthorityCitation;
}): EventTemplate {
  const tags: string[][] = [
    [TAG_SUBKIND, opts.vsk],
    [TAG_ENTITY, toHex(opts.entityId)],
    [TAG_EVERSION, opts.version.toString()],
    [TAG_VERSION, PROTOCOL_VERSION],
  ];
  if (opts.prevHash) tags.push([TAG_EPREV, toHex(opts.prevHash)]);
  if (opts.authority) tags.push(citationToTag(opts.authority));
  return {
    kind: KIND_COMMUNITY_CONTROL,
    content: opts.content,
    tags,
    created_at: opts.createdAtSecs,
  };
}

/** Sign an unsigned edition with the actor's secret key. */
export function signEdition(template: EventTemplate, actorSk: Uint8Array): NostrEvent {
  return finalizeEvent(template, actorSk);
}

export interface ParsedEdition {
  /** The real npub (hex) that signed this edition. */
  author: string;
  vsk: string;
  entityId: Uint8Array;
  version: bigint;
  prevHash?: Uint8Array;
  content: string;
  /** editionHash of this edition. */
  selfHash: Uint8Array;
  createdAt: number;
  innerId: Uint8Array;
  authority?: AuthorityCitation;
}

export type EditionError =
  | { code: "bad-signature" }
  | { code: "missing-field"; field: string }
  | { code: "bad-field"; field: string };

function decodeHash(hex: string | undefined, field: string): Uint8Array {
  if (!hex || !HEX64.test(hex)) throw { code: "bad-field", field } as EditionError;
  return hexToBytes(hex);
}

/**
 * Verify + parse an inner edition event. Checks the inner Schnorr signature and
 * extracts fields, computing selfHash. Rejects duplicate authority tags (which
 * would make the canonical bytes ambiguous → chain divergence). Does NOT check
 * roster authorization — that's the caller's separate step. Throws EditionError.
 */
export function parseEditionInner(inner: NostrEvent): ParsedEdition {
  if (!verifyEvent(inner)) throw { code: "bad-signature" } as EditionError;
  return parseEditionFields(inner, inner.pubkey);
}

/**
 * Parse an edition's FIELDS from an event whose authorship was proven
 * elsewhere. `author` is the proven actor.
 */
export function parseEditionFields(
  inner: Pick<NostrEvent, "tags" | "content" | "created_at" | "id">,
  author: string,
): ParsedEdition {

  for (const name of [TAG_SUBKIND, TAG_ENTITY, TAG_EVERSION, TAG_EPREV, TAG_AUTHORITY_CITATION]) {
    const count = inner.tags.filter((t) => t[0] === name).length;
    if (count > 1) throw { code: "bad-field", field: "duplicate authority tag" } as EditionError;
  }

  const get = (name: string): string | undefined => inner.tags.find((t) => t[0] === name)?.[1];

  const vsk = get(TAG_SUBKIND);
  if (vsk === undefined) throw { code: "missing-field", field: "vsk" } as EditionError;
  const eidStr = get(TAG_ENTITY);
  if (eidStr === undefined) throw { code: "missing-field", field: "eid" } as EditionError;
  const entityId = decodeHash(eidStr, "eid");
  const evStr = get(TAG_EVERSION);
  if (evStr === undefined) throw { code: "missing-field", field: "ev" } as EditionError;
  if (!/^\d+$/.test(evStr)) throw { code: "bad-field", field: "ev" } as EditionError;
  const version = BigInt(evStr);
  const epStr = get(TAG_EPREV);
  const prevHash = epStr !== undefined ? decodeHash(epStr, "ep") : undefined;

  const content = inner.content;
  const selfHash = editionHash(entityId, version, prevHash, new TextEncoder().encode(content));

  return {
    author,
    vsk,
    entityId,
    version,
    prevHash,
    content,
    selfHash,
    createdAt: inner.created_at,
    innerId: hexToBytes(inner.id),
    authority: citationFromTags(inner.tags),
  };
}

/** The `version.Edition` view used by `version.fold`. */
export function toFoldEdition(p: ParsedEdition): Edition {
  return {
    version: p.version,
    prevHash: p.prevHash,
    selfHash: p.selfHash,
    createdAt: p.createdAt,
    tiebreakId: p.innerId,
  };
}
