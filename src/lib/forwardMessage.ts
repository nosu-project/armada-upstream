import { KIND_DM_FILE } from "@/lib/nip17/protocol";

/**
 * What a forwarded message carries.
 *
 * Forwarding re-sends a message's CONTENT as a new message authored by the
 * forwarder — Signal's semantics, where the recipient sees an ordinary message
 * and nothing identifies the original sender. So everything that names the
 * source is dropped: the author (implicit — the forward is composed and signed
 * fresh), the reply/quote context (`e`/`q`), the addressing (`p`), the room
 * (`h`/`a`), the disappearing deadline (`expiration` — the DESTINATION's
 * retention applies, not the source room's), and edit/routing bookkeeping.
 *
 * Two kinds of tag are NOT context but part of the content itself, and are
 * carried verbatim:
 *
 *  - `imeta` (NIP-92). A media URL in the body renders as an attachment only
 *    via its imeta, and for a client-encrypted attachment the imeta is the ONLY
 *    place the AES-GCM key/nonce exists. Dropping it forwards a ciphertext URL
 *    nobody can decrypt — a silently broken forward. Carrying the tag verbatim
 *    also means the blob is re-referenced, never re-uploaded.
 *  - `emoji` (NIP-30). A `:shortcode:` in the body is meaningless without it,
 *    and the forwarder may not have the sender's emoji collection to re-derive
 *    it from.
 *
 * Both are filtered against the outgoing text, so nothing the user edited out
 * of the draft ships as a tag for content that isn't there.
 */

/** An imeta field list, parsed into `key → value` (fields are `"key value"`). */
function imetaFields(tag: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let i = 1; i < tag.length; i++) {
    const sp = tag[i].indexOf(" ");
    if (sp === -1) continue;
    const key = tag[i].slice(0, sp);
    if (!(key in fields)) fields[key] = tag[i].slice(sp + 1);
  }
  return fields;
}

/**
 * A NIP-17 kind-15 file message keeps its file metadata in TOP-LEVEL tags and
 * puts the bare blob URL in `content` (Amethyst/0xChat's shape) — there is no
 * imeta tag to carry. A forward is an ordinary kind-14 text message, where
 * those top-level tags mean nothing, so they're re-expressed as the equivalent
 * imeta. Without this, forwarding a received DM attachment drops
 * `decryption-key`/`decryption-nonce` and the recipient gets an undecryptable
 * blob.
 */
function fileMessageImeta(url: string, tags: string[][]): string[] | null {
  if (!/^https?:\/\//i.test(url)) return null;
  const flat: Record<string, string> = {};
  for (const [name, value] of tags) {
    if (name && value !== undefined && !(name in flat)) flat[name] = value;
  }
  const fields = [`url ${url}`];
  // `file-type` is NIP-17's spelling of the imeta `m` field.
  if (flat["file-type"]) fields.push(`m ${flat["file-type"]}`);
  else if (flat.m) fields.push(`m ${flat.m}`);
  for (const key of [
    "x",
    "ox",
    "size",
    "dim",
    "blurhash",
    "thumb",
    "image",
    "encryption-algorithm",
    "decryption-key",
    "decryption-nonce",
  ]) {
    if (flat[key]) fields.push(`${key} ${flat[key]}`);
  }
  return fields.length > 1 ? ["imeta", ...fields] : null;
}

/**
 * Filter `tags` down to the `imeta`/`emoji` entries the text still references.
 *
 * An `imeta` is kept only while its exact URL appears in `content` (exact
 * match, because that's how the renderer pairs the two), and an `emoji` only
 * while its `:shortcode:` does — so a URL the user deleted from the draft
 * doesn't ship a tag for content that isn't there. Duplicate URLs/shortcodes
 * keep the FIRST tag: a later duplicate would win in the renderer's map, which
 * would let an appended tag silently override the one already resolved.
 *
 * `skipUrls`/`skipShortcodes` exclude entries the caller has already emitted
 * from another source (a fresh upload in this composer session, the viewer's
 * own emoji collection), which take precedence.
 */
export function contentTagsFor(
  tags: string[][],
  content: string,
  skip?: { urls?: ReadonlySet<string>; shortcodes?: ReadonlySet<string> },
): string[][] {
  const out: string[][] = [];
  const seenUrls = new Set(skip?.urls);
  const seenShortcodes = new Set(skip?.shortcodes);

  for (const tag of tags) {
    if (tag[0] === "imeta") {
      const url = imetaFields(tag).url;
      if (!url || seenUrls.has(url) || !content.includes(url)) continue;
      seenUrls.add(url);
      out.push([...tag]);
    } else if (tag[0] === "emoji") {
      const [, shortcode, url] = tag;
      if (!shortcode || !url || seenShortcodes.has(shortcode)) continue;
      if (!content.includes(`:${shortcode}:`)) continue;
      seenShortcodes.add(shortcode);
      out.push([...tag]);
    }
  }
  return out;
}

/**
 * The tags a forward of `event` should carry, given the text actually being
 * sent (the user may edit the draft before sending it).
 */
export function forwardableTags(
  event: { kind: number; content: string; tags: string[][] },
  content: string = event.content,
): string[][] {
  const out = contentTagsFor(event.tags, content);

  // A kind-15's URL is its whole content, and it carries no imeta of its own —
  // unless one is already there, which is the more specific description.
  if (event.kind === KIND_DM_FILE) {
    const url = event.content.trim();
    const covered = out.some((t) => t[0] === "imeta" && imetaFields(t).url === url);
    if (!covered && content.includes(url)) {
      const imeta = fileMessageImeta(url, event.tags);
      if (imeta) out.push(imeta);
    }
  }

  return out;
}
