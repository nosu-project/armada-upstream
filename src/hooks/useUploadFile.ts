import { bytesToHex } from "@noble/hashes/utils.js";
import { BlossomUploader } from "@nostrify/nostrify/uploaders";
import { N64 } from "@nostrify/nostrify/utils";
import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";
import { z } from "zod";

import { getEffectiveBlossomServers, normalizeBlossomServerUrl } from "@/lib/blossom";
import { mediaSrc } from "@/lib/mediaPolicy";
import { preflightRefusal, uploadTimeoutMs, type PreflightRequest } from "@/lib/blossomPreflight";

import { useAppContext } from "./useAppContext";
import { useCurrentUser } from "./useCurrentUser";
import { useMediaPolicy } from "./useMediaPolicy";

import type { NostrSigner } from "@nostrify/nostrify";

export interface UploadRequest {
  file: File;
  signal?: AbortSignal;
}

/**
 * Upload to the user's Blossom servers (BUD-02), the preferred one's URL embedded when it
 * takes the blob (see `uploadToServers`). Returns NIP-94-style tags.
 */
export function useUploadFile() {
  const { config } = useAppContext();
  const { user } = useCurrentUser();

  return useMutation({
    mutationFn: async (request: File | UploadRequest) => {
      if (!user) {
        throw new Error("Must be logged in to upload files");
      }
      const { file, signal } = request instanceof File ? { file: request } as UploadRequest : request;

      // App defaults merged with the user's kind 10063 list (config.blossomServerMetadata),
      // the preferred server first.
      const servers = getEffectiveBlossomServers(
        config.appBlossomServers,
        config.blossomServerMetadata,
        config.useAppBlossomServers,
        config.preferredBlossomServer,
      );
      const preferred = normalizeBlossomServerUrl(config.preferredBlossomServer) ?? undefined;

      return uploadToServers(file, servers, user.signer, { preferred, signal });
    },
  });
}

/** `["url", …]` first, then the rest of a blob's NIP-94 tags. */
export type UploadTags = [["url", string], ...string[][]];

/** Another try for the preferred server after a failure that wasn't a refusal. */
const PREFERRED_RETRY_DELAY_MS = 1_000;

/** A Blossom error response, as Nostrify words it, so `uploadFailureReason` still reads it. */
class BlossomRequestError extends Error {
  constructor(readonly status: number, reason: string) {
    super(`Blossom request failed (${status}): ${reason}`);
  }
}

/**
 * PUT a file to every server at once (BUD-02) and pick the URL to embed: the
 * preferred server's when it takes the blob — retried once if it failed for a
 * reason other than a refusal — else the first other server's to succeed.
 * Every other server already holding the blob by then is listed as a NIP-94
 * `fallback`; any whose PUT fails is sent a `PUT /mirror` (BUD-04) instead.
 * Exported for testing.
 */
export async function uploadToServers(
  file: File,
  servers: string[],
  signer: NostrSigner,
  opts: { preferred?: string; signal?: AbortSignal } = {},
): Promise<UploadTags> {
  const { signal } = opts;
  const x = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())));
  // Scaled to the file size, so a flat timeout doesn't cap upload size by uplink speed.
  const timeoutMs = uploadTimeoutMs(file.size);
  // One token for every server and the retry, so a remote signer is asked once.
  const now = Date.now();
  const token = await signer.signEvent({
    kind: 24242,
    content: `Upload ${file.name}`,
    created_at: Math.floor(now / 1000),
    tags: [
      ["t", "upload"],
      ["expiration", String(Math.floor((now + 2 * timeoutMs + 60_000) / 1000))],
      ["x", x],
    ],
  });
  const authorization = `Nostr ${N64.encodeEventUrl(token)}`;

  const put = async (server: string): Promise<UploadTags> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await globalThis.fetch(new URL("/upload", server), {
      method: "PUT",
      body: file,
      headers: { authorization, "content-type": file.type, "x-sha-256": x },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    return finishTags(await parseDescriptor(response, x), file.name);
  };

  const preferred = opts.preferred && servers.includes(opts.preferred) ? opts.preferred : undefined;
  const held = new Map<string, UploadTags>();
  const attempts = new Map<string, Promise<UploadTags>>(
    servers.map((server) => {
      let attempt = put(server);
      if (server === preferred) {
        attempt = attempt.catch(async (error: unknown) => {
          if (signal?.aborted || error instanceof BlossomRequestError && error.status < 500) throw error;
          await new Promise((resolve) => setTimeout(resolve, PREFERRED_RETRY_DELAY_MS));
          if (signal?.aborted) throw error;
          return put(server);
        });
      }
      attempt.then((tags) => held.set(server, tags), () => {});
      return [server, attempt];
    }),
  );

  const others = servers.filter((server) => server !== preferred);
  let winner: string;
  let tags: UploadTags;
  try {
    [winner, tags] = await (async (): Promise<[string, UploadTags]> => {
      if (preferred) {
        try {
          return [preferred, await attempts.get(preferred)!];
        } catch (error) {
          if (others.length === 0 || signal?.aborted) throw new AggregateError([error]);
        }
      }
      return Promise.any(others.map(async (server) => [server, await attempts.get(server)!] as [string, UploadTags]));
    })();
  } catch (error) {
    // Every server's reason, the preferred one's included, for `uploadFailureReason`.
    const settled = await Promise.allSettled(attempts.values());
    const reasons = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    throw reasons.length > 0 ? new AggregateError(reasons) : error;
  }

  const url = tags[0][1];
  for (const server of servers) {
    if (server === winner) continue;
    const copy = held.get(server)?.[0][1];
    if (copy && copy !== url) tags.push(["fallback", copy]);
  }

  // Best-effort: whoever didn't take the PUT gets a chance to fetch the blob itself.
  for (const server of servers) {
    if (server === winner || held.has(server)) continue;
    attempts.get(server)!.catch((error: unknown) => {
      // A refusal (too large, wrong type, unauthorized) would refuse the mirror too.
      if (signal?.aborted || error instanceof BlossomRequestError && error.status < 500) return;
      mirrorToServers(url, [server], signer).catch(() => {});
    });
  }

  return tags;
}

/** A BUD-02 blob descriptor as NIP-94 tags, the server's own `nip94` taking precedence. */
async function parseDescriptor(response: Response, x: string): Promise<UploadTags> {
  const text = await response.text();
  if (!response.ok) {
    throw new BlossomRequestError(response.status, response.headers.get("x-reason") ?? text);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Blossom server returned non-JSON response: ${text}`);
  }
  const data = DescriptorSchema.parse(json);
  if (data.nip94?.length) {
    const url = data.nip94.find(([name]) => name === "url")?.[1] ?? data.url;
    return [["url", url], ...data.nip94.filter(([name]) => name !== "url")];
  }
  const tags: UploadTags = [["url", data.url], ["x", data.sha256], ["ox", x], ["size", String(data.size)]];
  if (data.dim) tags.push(["dim", data.dim]);
  if (data.type) tags.push(["m", data.type]);
  return tags;
}

const DescriptorSchema = z.object({
  url: z.string(),
  sha256: z.string(),
  size: z.number(),
  type: z.string().optional(),
  dim: z.string().regex(/^\d+x\d+$/).optional().catch(undefined),
  nip94: z.array(z.array(z.string())).optional().catch(undefined),
});

function finishTags(tags: UploadTags, filename: string): UploadTags {
  // Some servers emit a doubled scheme; once sealed into a message it'd be permanently wrong.
  tags[0][1] = repairDoubledScheme(tags[0][1]);
  // Content-addressed URLs may omit the extension; append it for media-type detection.
  const ext = getFileExtension(filename);
  if (ext) tags[0][1] = appendExtensionIfMissing(tags[0][1], ext);
  return tags;
}

/**
 * Copy a remote file onto the user's Blossom servers so it survives its owner
 * deleting it. BUD-04 mirror first, else download (through the media policy) and upload.
 */
export function useRehostFile() {
  const { config } = useAppContext();
  const { user } = useCurrentUser();
  const policy = useMediaPolicy();

  return useMutation({
    mutationFn: async (sourceUrl: string): Promise<string> => {
      if (!user) throw new Error("Must be logged in to upload files");

      const servers = getEffectiveBlossomServers(
        config.appBlossomServers,
        config.blossomServerMetadata,
        config.useAppBlossomServers,
        config.preferredBlossomServer,
      );
      const originOf = (u: string) => {
        try {
          return new URL(u).origin;
        } catch {
          return undefined;
        }
      };
      const sourceOrigin = originOf(sourceUrl);
      if (servers.some((s) => originOf(s) === sourceOrigin)) return sourceUrl;

      const uploader = new BlossomUploader({
        servers,
        signer: user.signer,
        fetch: (input, init) =>
          globalThis.fetch(input, {
            ...init,
            signal: init?.signal
              ? AbortSignal.any([init.signal, AbortSignal.timeout(60_000)])
              : AbortSignal.timeout(60_000),
          }),
      });

      let tags: string[][];
      try {
        tags = await uploader.mirror(sourceUrl);
      } catch {
        // Fetching the creator's host from here is a sender-named load like any image.
        const src = mediaSrc(sourceUrl, policy);
        if (!src) throw new Error("This file can't be copied.");
        const response = await globalThis.fetch(src, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`Download failed (${response.status})`);
        const blob = await response.blob();
        const name = new URL(sourceUrl).pathname.split("/").pop() || "file";
        tags = await uploader.upload(new File([blob], name, { type: blob.type }));
      }

      const url = repairDoubledScheme(tags[0][1]);
      const mirrorServers = servers.filter((s) => originOf(s) !== originOf(url));
      if (mirrorServers.length > 0) {
        mirrorToServers(url, mirrorServers, user.signer).catch(() => { /* best-effort */ });
      }
      return url;
    },
  });
}

/**
 * Ask the target servers whether they'll take a blob (BUD-06) before preparing it; resolves to
 * the refusal when every server refuses — see `preflightRefusal`.
 */
export function useUploadPreflight() {
  const { config } = useAppContext();
  const { appBlossomServers, blossomServerMetadata, useAppBlossomServers, preferredBlossomServer } = config;
  return useCallback(
    (req: PreflightRequest, signal?: AbortSignal) =>
      preflightRefusal(
        getEffectiveBlossomServers(appBlossomServers, blossomServerMetadata, useAppBlossomServers, preferredBlossomServer),
        req,
        { signal },
      ),
    [appBlossomServers, blossomServerMetadata, useAppBlossomServers, preferredBlossomServer],
  );
}

function getFileExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex <= 0) return "";
  return filename.slice(dotIndex).toLowerCase();
}

/**
 * Collapse a doubled leading scheme (`https://https//host/…` or `https://https://host/…`)
 * some Blossom servers emit.
 */
export function repairDoubledScheme(url: string): string {
  const m = url.match(/^(https?):\/\/(https?):?\/\/(.+)$/i);
  if (m) return `${m[2].toLowerCase()}://${m[3]}`;
  return url;
}

function appendExtensionIfMissing(urlString: string, ext: string): string {
  try {
    const url = new URL(urlString);
    const lastSegment = url.pathname.split("/").pop() ?? "";
    if (lastSegment.includes(".")) return urlString;
    url.pathname = url.pathname + ext;
    return url.toString();
  } catch {
    return urlString;
  }
}

/** Each server gets its own `PUT /mirror`. Exported for testing. */
export async function mirrorToServers(
  sourceUrl: string,
  servers: string[],
  signer: NostrSigner,
): Promise<void> {
  await Promise.allSettled(
    servers.map((server) => {
      // Nostrify's BUD-04/BUD-11 auth carries the required verb, hash and URL; hand-built
      // `t=mirror` events are refused (403) by conforming servers.
      const uploader = new BlossomUploader({
        servers: [server],
        signer,
        fetch: (input, init) =>
          globalThis.fetch(input, {
            ...init,
            signal: AbortSignal.any([
              init?.signal ?? AbortSignal.timeout(30_000),
              AbortSignal.timeout(30_000),
            ]),
          }),
      });
      return uploader.mirror(sourceUrl);
    }),
  );
}
