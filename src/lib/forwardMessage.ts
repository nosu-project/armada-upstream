import { KIND_DM_FILE } from "@/lib/nip17/protocol";

/**
 * Forwarding re-sends a message's CONTENT as a new message by the forwarder
 * (Signal semantics): author, reply/quote, `p`, room, `expiration`, and edit
 * bookkeeping are dropped. `imeta` (NIP-92; for encrypted attachments the only
 * place the AES key lives) and `emoji` (NIP-30) are content, carried verbatim
 * but filtered to what the outgoing text still references.
 */

/**
 * Parse an imeta tag's `"key value"` fields. A bare `content-warning` (spoiler
 * with no reason) is kept rather than dropped as valueless.
 */
function imetaFields(tag: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let i = 1; i < tag.length; i++) {
    const sp = tag[i].indexOf(" ");
    if (sp === -1) {
      if (tag[i] === "content-warning" && !("content-warning" in fields)) fields["content-warning"] = "spoiler";
      continue;
    }
    const key = tag[i].slice(0, sp);
    if (!(key in fields)) fields[key] = tag[i].slice(sp + 1);
  }
  return fields;
}

/**
 * NIP-17 kind-15 file messages keep file metadata in top-level tags; a forward
 * is kind 14, so re-express them as imeta or the decryption key is lost.
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
 * Filter `tags` to the `imeta`/`emoji` entries still referenced (exact URL /
 * `:shortcode:`) in `content`. Duplicates keep the FIRST tag. `skipUrls`/
 * `skipShortcodes` exclude entries the caller already emits from elsewhere.
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
 * A forwarded `imeta` split into the composer's upload shape: NIP-94 pairs plus
 * separate AES-GCM params, so it renders as an attachment chip like a fresh
 * upload. Encryption params are removed from the pairs or they'd be emitted twice.
 */
export interface ForwardedAttachment {
  url: string;
  tags: string[][];
  encryption?: { algorithm: string; key: string; nonce: string; ox?: string };
}

/** Decompose an `imeta` tag into a {@link ForwardedAttachment}, or `null` without a URL. */
export function forwardedAttachment(tag: string[]): ForwardedAttachment | null {
  const fields = imetaFields(tag);
  if (!fields.url) return null;

  const algorithm = fields["encryption-algorithm"];
  const key = fields["decryption-key"];
  const nonce = fields["decryption-nonce"];
  const encrypted = Boolean(algorithm && key && nonce);

  const tags: string[][] = [];
  for (const [name, value] of Object.entries(fields)) {
    // `ox` rides with the encryption params when encrypted, but is ordinary NIP-94 otherwise.
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

/** Remove `urls` from `text` (they move to attachment chips and are re-appended on send). */
export function stripUrlsFromText(text: string, urls: Iterable<string>): string {
  const list = [...urls];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    let stripped = line;
    for (const url of list) stripped = stripped.split(url).join("");
    stripped = stripped.replace(/[^\S\n]{2,}/g, " ").trim();
    // A line that held only the URL goes; an already-blank line is a paragraph break and stays.
    if (!stripped && line.trim()) continue;
    kept.push(stripped);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Tags a forward of `event` should carry, given the (possibly edited) text being sent. */
export function forwardableTags(
  event: { kind: number; content: string; tags: string[][] },
  content: string = event.content,
): string[][] {
  const out = contentTagsFor(event.tags, content);

  // A kind-15's URL is its whole content; prefer an existing imeta if present.
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
