/**
 * Runs {@link auditHistory} and the {@link historyExport} writers as an in-app
 * tool: an exhaustive control sweep, a per-channel backfill to the floor (written
 * back to the store), a fold into the surviving timeline, optional inlining of
 * media as `data:` URIs, then the verdict plus {@link ExportModel}.
 *
 * Imperative (`run()`), not a query: a long operation the user starts and watches.
 */

import { useNostr } from "@nostrify/react";
import { useCallback, useMemo, useRef, useState } from "react";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { foldTimeline, openChatBatch, replyTargetOf } from "@/concord/lib/chat";
import { backfillStore } from "@/concord/lib/channelSync";
import { expirationOf } from "@/concord/lib/disappearing";
import { useChatModeration } from "@/concord/hooks/useChannel";
import { useChannels, useControlFold } from "@/concord/hooks/useControlPlane";
import {
  auditHistory,
  type AuditOptions,
  type ChannelCollection,
  type ControlCollection,
  type HistoryReport,
  type RelayCoverage,
} from "@/concord/lib/historyAudit";
import {
  type ExportAttachment,
  type ExportChannel,
  type ExportMessage,
  type ExportModel,
  type ExportProfile,
} from "@/concord/lib/historyExport";
import { sniffImageMime } from "@/concord/lib/image";
import { useBlossomServers } from "@/hooks/useBlossomServers";
import { mediaCandidates } from "@/lib/blossom";
import {
  controlSweepQuorum,
  controlSweepRelayReached,
  controlSweepTruncated,
  sweepControl,
} from "@/concord/lib/planeSync";
import { queryChannelRumors, writeRumors } from "@/concord/lib/rumorStore";
import type { Channel, Community } from "@/concord/lib/types";
import { parseAuthorEvent } from "@/lib/authorCache";
import { decryptBuffer, fetchCapped, verifyPlaintextHash } from "@/lib/encryptedMedia";
import { parseImetaMap, type ImetaEntry } from "@/lib/imeta";
import { routeMediaCandidates, type MediaPolicy } from "@/lib/mediaPolicy";
import { sanitizeUrl } from "@/lib/sanitizeUrl";
import { useMediaPolicy } from "@/hooks/useMediaPolicy";

/** Backfill rounds per channel; each round pages up to 20×50 wraps oldest-ward. */
const MAX_BACKFILL_ROUNDS = 60;
/** Total decrypted media bytes one export may embed. */
const ASSET_TOTAL_BUDGET = 40 * 1024 * 1024;
/** Larger assets stay a link. */
const ASSET_MAX_EACH = 8 * 1024 * 1024;
/** AES-GCM appends a 16-byte tag, so ciphertext runs that much past plaintext. */
const GCM_TAG_BYTES = 16;
/** kind-0 authors per relay query. */
const PROFILE_BATCH = 100;

export type AuditPhase = "idle" | "control" | "channels" | "profiles" | "assets" | "done" | "error";

export interface AuditProgress {
  phase: AuditPhase;
  label?: string;
  done: number;
  total: number;
}

export interface HistoryAuditResult {
  report: HistoryReport;
  model: ExportModel;
}

export interface RunOptions {
  /** Fetch + decrypt + inline images/avatars as data URIs (needed for a self-contained HTML). */
  embedAssets?: boolean;
  /** Passed through to {@link auditHistory} (e.g. `danglingIsBlocker` for a pre-compaction gate). */
  auditOptions?: AuditOptions;
  /**
   * Only messages at or after this epoch-ms; bounds both the backfill and the store read.
   */
  sinceMs?: number;
  /** Restrict sweep + export to these channel idHex values; undefined = all. */
  channelIds?: ReadonlySet<string>;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** An image, or unknown-but-likely one. */
function isEmbeddableImage(entry: ImetaEntry): boolean {
  return !entry.mime || entry.mime.startsWith("image/");
}

/**
 * Fetch a URL (decrypting when `enc` is present) as a `data:` URI. Never throws:
 * an export would rather drop or link an asset than abort.
 */
async function fetchImageDataUri(
  url: string,
  enc: ImetaEntry["encryption"],
  signal: AbortSignal,
  budget: { left: number },
  servers: readonly string[],
  policy: MediaPolicy,
): Promise<{ dataUri?: string; mime?: string; failed: boolean }> {
  try {
    // Cap the READ at the budget (+ GCM tag) so oversized assets aren't buffered.
    // Walk other Blossom servers for content-addressed blobs, and route through the
    // media policy (proxy) like the timeline does.
    const { sources } = routeMediaCandidates(mediaCandidates(url, undefined, servers), policy);
    const raw = await fetchCapped(sources, {
      signal,
      maxBytes: Math.min(ASSET_MAX_EACH, budget.left) + GCM_TAG_BYTES,
    });
    let bytes = new Uint8Array(raw);
    if (enc) {
      bytes = new Uint8Array(await decryptBuffer(raw, enc.key, enc.nonce));
      // An export is evidence; never embed bytes whose hash the sender didn't vouch for.
      await verifyPlaintextHash(bytes, enc.ox);
    }
    if (bytes.length > ASSET_MAX_EACH || bytes.length > budget.left) {
      // Too big: a plaintext one stays a link, an encrypted one can't.
      return { failed: Boolean(enc) };
    }
    budget.left -= bytes.length;
    const mime = bytes.length ? sniffImageMime(bytes) : "application/octet-stream";
    return { dataUri: `data:${mime};base64,${bytesToBase64(bytes)}`, mime, failed: false };
  } catch {
    return { failed: Boolean(enc) };
  }
}

/** Exhaustively backfill one channel's wraps across every relay. */
async function collectChannelWraps(
  nostr: { relay(url: string): { query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]> } },
  community: Community,
  channel: Channel,
  signal: AbortSignal,
  sinceSecs?: number,
): Promise<{ wraps: NostrEvent[]; exhausted: boolean; failed: boolean }> {
  const wraps: NostrEvent[] = [];
  let until: number | undefined;
  let exhausted = false;
  let failed = false;
  for (let round = 0; round < MAX_BACKFILL_ROUNDS; round++) {
    if (signal.aborted) break;
    const r = await backfillStore(nostr, community.relays, channel, signal, { until, since: sinceSecs, maxPages: 20 });
    wraps.push(...r.events);
    if (r.failed) failed = true;
    if (r.exhausted) {
      exhausted = true;
      break;
    }
    if (r.oldest === undefined) break; // nothing came back — no deeper history to page
    const next = r.oldest - 1;
    if (until !== undefined && next >= until) break; // cursor didn't advance
    until = next;
  }
  return { wraps, exhausted, failed };
}

function buildExportMessages(timeline: ReturnType<typeof foldTimeline>): {
  messages: ExportMessage[];
  pending: Array<{ ref: ExportAttachment; entry: ImetaEntry }>;
} {
  const pending: Array<{ ref: ExportAttachment; entry: ImetaEntry }> = [];
  const messages = timeline.messages
    // Disappearing messages (NIP-40 `expiration`, CORD-08) are excluded from a
    // permanent export even before their deadline.
    .filter((m) => expirationOf(m.tags) === undefined)
    .map((m): ExportMessage => {
    const byEmoji = timeline.reactions.get(m.rumorId);
    const reactions = byEmoji
      ? [...byEmoji.entries()].map(([emoji, entry]) => ({ emoji, count: entry.reactors.size }))
      : [];
    const attachments: ExportAttachment[] = [];
    for (const entry of parseImetaMap(m.tags).values()) {
      const ref: ExportAttachment = { url: entry.url, ...(entry.mime ? { mime: entry.mime } : {}) };
      attachments.push(ref);
      if (isEmbeddableImage(entry)) pending.push({ ref, entry });
    }
    const replyTo = replyTargetOf(m);
    return {
      rumorId: m.rumorId,
      author: m.author,
      ms: m.ms,
      kind: m.kind,
      content: m.content,
      ...(m.tags.some(([n]) => n === "edited") ? { edited: true } : {}),
      ...(replyTo ? { replyTo } : {}),
      reactions,
      attachments,
    };
  });
  return { messages, pending };
}

export function useHistoryAudit(community: Community | undefined) {
  const { nostr } = useNostr();
  const channels = useChannels(community);
  const { data: folded } = useControlFold(community);
  const moderation = useChatModeration(community);
  const servers = useBlossomServers();
  const policy = useMediaPolicy();

  const [progress, setProgress] = useState<AuditProgress>({ phase: "idle", done: 0, total: 0 });
  const [result, setResult] = useState<HistoryAuditResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const canRun = Boolean(community && folded);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const run = useCallback(
    async (opts?: RunOptions): Promise<HistoryAuditResult | undefined> => {
      if (!community || !folded) return undefined;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const signal = controller.signal;
      const embedAssets = opts?.embedAssets ?? true;
      const sinceMs = opts?.sinceMs;
      const sinceSecs = sinceMs !== undefined ? Math.floor(sinceMs / 1000) : undefined;
      // An unpicked channel is never backfilled.
      const selectedChannels = opts?.channelIds
        ? channels.filter((c) => opts.channelIds!.has(c.idHex))
        : channels;

      setError(null);
      setResult(null);
      try {
        // 1. Control plane — exhaustive sweep.
        setProgress({ phase: "control", done: 0, total: 1, label: "Reading the control plane" });
        await sweepControl(nostr, community, { exhaustive: true });
        const control: ControlCollection = {
          incompleteEntities: folded.incomplete,
          truncated: controlSweepTruncated(community),
          quorum: controlSweepQuorum(community),
          relays: community.relays.map((url): RelayCoverage => {
            const reached = controlSweepRelayReached(community, url);
            return { url, answered: reached, failed: !reached };
          }),
          channelCount: folded.channels.size,
          memberCount: folded.roster.grants.length,
        };

        // 2. Chat plane — every channel, every epoch, paged to the floor.
        const collections: ChannelCollection[] = [];
        const exportChannels: ExportChannel[] = [];
        const pendingAssets: Array<{ ref: ExportAttachment; entry: ImetaEntry }> = [];
        const authors = new Set<string>();

        for (let i = 0; i < selectedChannels.length; i++) {
          if (signal.aborted) throw new Error("cancelled");
          const channel = selectedChannels[i];
          setProgress({ phase: "channels", done: i, total: selectedChannels.length, label: `#${channel.name}` });

          const { wraps, exhausted, failed } = await collectChannelWraps(nostr, community, channel, signal, sinceSecs);
          const openedWire = await openChatBatch(wraps, channel, { signal });
          // Write THEN read back, so the export comes purely from durable rumors.
          if (openedWire.length) await writeRumors(community.idHex, openedWire);
          const allRumors = await queryChannelRumors(community.idHex, channel.idHex, { limit: 1_000_000, signal });
          const rumors = sinceMs !== undefined ? allRumors.filter((r) => r.ms >= sinceMs) : allRumors;

          // Real moderation context, so moderator deletes are excluded as in the timeline.
          const timeline = foldTimeline(rumors, moderation);
          for (const m of timeline.messages) authors.add(m.author);

          const queriedEpochs = channel.streams.map((s) => s.epoch.toString());
          collections.push({
            channelIdHex: channel.idHex,
            name: channel.name,
            isPrivate: channel.isPrivate,
            deleted: false,
            opened: rumors,
            messageCount: timeline.messages.length,
            queriedEpochs,
            exhaustedEpochs: exhausted ? queriedEpochs : [],
            relays: community.relays.map((url): RelayCoverage => ({ url, answered: true, failed })),
          });

          const { messages, pending } = buildExportMessages(timeline);
          pendingAssets.push(...pending);
          exportChannels.push({
            channelIdHex: channel.idHex,
            name: channel.name,
            isPrivate: channel.isPrivate,
            messages,
          });
        }

        setProgress({ phase: "profiles", done: 0, total: 1, label: "Resolving members" });
        const profiles: Record<string, ExportProfile> = {};
        const authorList = [...authors];
        for (const batch of chunk(authorList, PROFILE_BATCH)) {
          if (signal.aborted) throw new Error("cancelled");
          const events = await nostr.query([{ kinds: [0], authors: batch }], { signal });
          const newest = new Map<string, NostrEvent>();
          for (const ev of events) {
            const prev = newest.get(ev.pubkey);
            if (!prev || ev.created_at > prev.created_at) newest.set(ev.pubkey, ev);
          }
          for (const [pk, ev] of newest) {
            const { metadata } = parseAuthorEvent(ev);
            const name = metadata?.name || metadata?.display_name || "";
            // Member-controlled URL that ends up in a `<style>` rule; scheme-check at the
            // source as well as at the sink.
            const picture = sanitizeUrl(metadata?.picture);
            profiles[pk] = { pubkey: pk, name, ...(picture ? { picture } : {}) };
          }
        }
        for (const pk of authorList) profiles[pk] ??= { pubkey: pk, name: "" };

        let iconDataUri: string | undefined;
        if (embedAssets) {
          const budget = { left: ASSET_TOTAL_BUDGET };
          const icon = folded.metadata?.icon;
          if (icon) {
            const r = await fetchImageDataUri(icon.url, { algorithm: "aes-gcm", key: icon.key, nonce: icon.nonce }, signal, budget, servers, policy);
            if (r.dataUri) iconDataUri = r.dataUri;
          }
          const total = authorList.length + pendingAssets.length;
          let done = 0;
          setProgress({ phase: "assets", done, total, label: "Embedding media" });
          for (const pk of authorList) {
            if (signal.aborted) throw new Error("cancelled");
            const pic = profiles[pk].picture;
            if (pic) {
              const r = await fetchImageDataUri(pic, undefined, signal, budget, servers, policy);
              // A self-contained file must not fetch a remote avatar on open.
              if (r.dataUri) {
                profiles[pk] = { ...profiles[pk], picture: r.dataUri };
              } else {
                const { picture: _drop, ...rest } = profiles[pk];
                profiles[pk] = rest;
              }
            }
            setProgress({ phase: "assets", done: ++done, total, label: "Embedding media" });
          }
          for (const { ref, entry } of pendingAssets) {
            if (signal.aborted) throw new Error("cancelled");
            const r = await fetchImageDataUri(entry.url, entry.encryption, signal, budget, servers, policy);
            if (r.dataUri) {
              ref.dataUri = r.dataUri;
              if (r.mime) ref.mime = r.mime;
            } else if (r.failed) {
              ref.failed = true;
            }
            setProgress({ phase: "assets", done: ++done, total, label: "Embedding media" });
          }
        }

        const now = Date.now();
        const report = auditHistory({
          communityIdHex: community.idHex,
          control,
          channels: collections,
          now,
          ...(opts?.auditOptions ? { options: opts.auditOptions } : {}),
        });
        const model: ExportModel = {
          communityName: folded.metadata?.name || community.name,
          communityIdHex: community.idHex,
          generatedAtMs: now,
          ...(iconDataUri ? { icon: iconDataUri } : {}),
          profiles,
          channels: exportChannels,
        };
        const out = { report, model };
        setResult(out);
        setProgress({ phase: "done", done: 1, total: 1 });
        return out;
      } catch (e) {
        if (signal.aborted) {
          setProgress({ phase: "idle", done: 0, total: 0 });
          return undefined;
        }
        setError(e instanceof Error ? e.message : "The history audit failed.");
        setProgress({ phase: "error", done: 0, total: 0 });
        return undefined;
      }
    },
    [community, folded, channels, moderation, nostr, servers, policy],
  );

  const channelCount = useMemo(() => channels.length, [channels]);

  return { run, cancel, canRun, progress, result, error, channels, channelCount };
}
