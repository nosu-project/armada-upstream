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
 * A forwarded `imeta` decomposed into the shape the composer already holds
 * uploads in: NIP-94 `[key, value]` pairs plus, separately, the AES-GCM params.
 *
 * A forwarded attachment is an ATTACHMENT, not a URL in the message text — it
 * gets a chip above the input (previewable, removable, and for an encrypted
 * blob decrypted for that preview) exactly like a file picked here, and its
 * URL is re-appended to the body on send. That's why this splits rather than
 * passing the tag through: the composer's chip rendering, draft persistence
 * and imeta regeneration all read these two structures, and reconstruct an
 * equivalent imeta from them.
 *
 * The encryption params are lifted OUT of the pairs because the composer
 * re-appends them from the encryption map; leaving them in both would emit
 * each field twice.
 */
export interface ForwardedAttachment {
  url: string;
  /** NIP-94 pairs, including `["url", …]` — the composer's upload shape. */
  tags: string[][];
  encryption?: { algorithm: string; key: string; nonce: string; ox?: string };
}

/**
 * Decompose an `imeta` tag into a {@link ForwardedAttachment}, or `null` when
 * it names no URL.
 */
export function forwardedAttachment(tag: string[]): ForwardedAttachment | null {
  const fields = imetaFields(tag);
  if (!fields.url) return null;

  const algorithm = fields["encryption-algorithm"];
  const key = fields["decryption-key"];
  const nonce = fields["decryption-nonce"];
  const encrypted = Boolean(algorithm && key && nonce);

  const tags: string[][] = [];
  for (const [name, value] of Object.entries(fields)) {
    // `ox` rides with the encryption params (the composer re-appends it there),
    // but is an ordinary NIP-94 field on a plaintext attachment.
    if (encrypted && (name === "ox" || name.startsWith("encryption-") || name.startsWith("decryption-"))) {
      continue;
    }
    tags.push([name, value]);
  }

  return {
    url: fields.url,
    tags,
    encryption: encrypted ? { algorithm, key, nonce, ox: fields.ox } : undefined,
  };
}

/**
 * Remove `urls` from `text` and tidy the whitespace they leave behind.
 *
 * Forwarded media moves out of the body and into an attachment chip, so the
 * bare URL must not also sit in the draft — the composer re-appends it on
 * send, and leaving it would send it twice.
 */
export function stripUrlsFromText(text: string, urls: Iterable<string>): string {
  const list = [...urls];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    let stripped = line;
    for (const url of list) stripped = stripped.split(url).join("");
    stripped = stripped.replace(/[^\S\n]{2,}/g, " ").trim();
    // A line that held nothing but the URL goes with it — the common shape,
    // where the media was the whole message or sat under a caption. A line
    // that was ALREADY blank is the author's paragraph break, and stays.
    if (!stripped && line.trim()) continue;
    kept.push(stripped);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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
