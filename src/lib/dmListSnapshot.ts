/**
 * Last-known-good snapshot of the DM conversation list, in its FINAL rendered
 * form.
 *
 * The list is derived from four asynchronous local sources — the kind-4 event
 * store, the NIP-17 rumor store, the mute set, and the follow list — and its
 * order depends on all of them at once: a NIP-17 rumor supplies the newest
 * message for many peers, and the follow set decides which peers appear at all.
 * Blocking on all four is correct but slow (the first IndexedDB read after a
 * cold Android WebView launch costs seconds), and seeding the first frame from
 * raw events is worse: any partial view of those sources produces a
 * deterministically WRONG order that visibly re-sorts once the rest arrive.
 *
 * So this snapshots the OUTCOME instead of the inputs: the merged, filtered,
 * sorted rows exactly as they were last rendered. Reading it back paints a list
 * that is already in its final order — the live data replaces it moments later
 * and, absent new messages, produces the same order, so nothing moves.
 *
 * This is deliberately NOT `timelineSnapshot` (which stores a truncated tail of
 * one timeline's raw events, the right shape for a thread and the wrong one
 * here).
 *
 * Trust note: `preview` is decrypted message text at rest, the same device
 * trust level as the DM thread snapshots and the signer's persistent decrypt
 * cache. The `armada:` prefix means `purgeClientStorage` wipes it on logout.
 */

const PREFIX = "armada:dmlist:v1:";

/**
 * Rows kept. Comfortably more than a screenful, so scrolling the restored list
 * doesn't hit a cliff before the live data lands.
 */
const MAX_ROWS = 100;

/** One conversation row, flattened to what the list needs to render it. */
export interface DmListSnapshotRow {
  peer: string;
  /** Timestamp of the latest message — the list's sort key. */
  createdAt: number;
  /** Author of the latest message; drives the unread state. */
  author: string;
  /** Decrypted preview text, when it was available at write time. */
  preview?: string;
  /**
   * The latest message's NIP-30 `emoji` tags, so a restored preview renders
   * custom emoji as images on the first frame. Only `emoji` tags are kept —
   * the rest (`p`, `e`, …) are irrelevant to rendering and would bloat this.
   */
  emojiTags?: string[][];
  /**
   * The latest message's NIP-40 deadline, when it is a disappearing message.
   * Read-back drops the preview past it: a message that has disappeared must
   * not keep showing its text here just because this snapshot is faster than
   * the live read.
   */
  expiresAt?: number;
  /** The viewer has authored at least one message in this conversation. */
  mine: boolean;
}

/** Pick just the NIP-30 emoji tags out of a message's tags, or undefined. */
export function pickEmojiTags(tags: readonly string[][] | undefined): string[][] | undefined {
  const picked = (tags ?? []).filter((t) => t[0] === "emoji" && t[1] && t[2]);
  return picked.length > 0 ? picked : undefined;
}

function isRow(value: unknown): value is DmListSnapshotRow {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.peer === "string" &&
    typeof r.createdAt === "number" &&
    typeof r.author === "string" &&
    typeof r.mine === "boolean" &&
    (r.expiresAt === undefined || typeof r.expiresAt === "number") &&
    (r.preview === undefined || typeof r.preview === "string") &&
    (r.emojiTags === undefined ||
      (Array.isArray(r.emojiTags) &&
        r.emojiTags.every((t) => Array.isArray(t) && t.every((s) => typeof s === "string"))))
  );
}

/**
 * Read the stored list for an account, newest-first, or undefined on
 * miss/corruption. Synchronous — safe on the render path.
 */
export function readDmListSnapshot(self: string | undefined): DmListSnapshotRow[] | undefined {
  if (!self || typeof localStorage === "undefined") return undefined;
  try {
    const raw = localStorage.getItem(PREFIX + self);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    // A disappearing message's preview dies with the message. The row itself
    // stays (dropping it would make the conversation blink out and back as the
    // live read lands); only the decrypted text and its emoji go.
    const now = Math.floor(Date.now() / 1000);
    const rows = parsed
      .filter(isRow)
      .map((row) =>
        row.expiresAt !== undefined && row.expiresAt <= now
          ? { ...row, preview: undefined, emojiTags: undefined }
          : row,
      );
    return rows.length > 0 ? rows : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist the list for an account. `rows` must be in render order (newest
 * first) and already filtered — muted and unfollowed peers must be gone before
 * they get here, or a later cold start would paint them back.
 */
export function writeDmListSnapshot(self: string | undefined, rows: readonly DmListSnapshotRow[]): void {
  if (!self || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PREFIX + self, JSON.stringify(rows.slice(0, MAX_ROWS)));
  } catch {
    // Quota/unavailable — the snapshot is purely a first-paint optimization.
  }
}
