import { BlossomUploader } from "@nostrify/nostrify/uploaders";
import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";

import { getEffectiveBlossomServers } from "@/lib/blossom";
import { preflightRefusal, uploadTimeoutMs, type PreflightRequest } from "@/lib/blossomPreflight";

import { useAppContext } from "./useAppContext";
import { useCurrentUser } from "./useCurrentUser";

import type { NostrSigner } from "@nostrify/nostrify";

export interface UploadRequest {
  file: File;
  signal?: AbortSignal;
}

/**
 * Upload to the user's Blossom servers (BUD-02), mirroring to the rest in the background
 * (BUD-04). Returns NIP-94-style tags.
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

      // App defaults merged with the user's kind 10063 list (config.blossomServerMetadata).
      const servers = getEffectiveBlossomServers(
        config.appBlossomServers,
        config.blossomServerMetadata,
        config.useAppBlossomServers,
      );

      // Scaled to the file size, so a flat timeout doesn't cap upload size by uplink speed.
      const timeoutMs = uploadTimeoutMs(file.size);
      const uploader = new BlossomUploader({
        servers,
        signer: user.signer,
        fetch: (input, init) =>
          globalThis.fetch(input, {
            ...init,
            signal: init?.signal
              ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
              : AbortSignal.timeout(timeoutMs),
          }),
      });

      const tags = await uploader.upload(file, { signal });

      // Some servers emit a doubled scheme; once sealed into a message it'd be permanently wrong.
      tags[0][1] = repairDoubledScheme(tags[0][1]);

      // Content-addressed URLs may omit the extension; append it for media-type detection.
      const ext = getFileExtension(file.name);
      if (ext) {
        tags[0][1] = appendExtensionIfMissing(tags[0][1], ext);
      }

      const url = tags[0][1];

      // Mirror to all other servers in the background (BUD-04, best-effort).
      const uploadedServer = servers.find((s) => url.startsWith(s.replace(/\/+$/, "")));
      const mirrorServers = servers.filter((s) => s !== uploadedServer);
      if (mirrorServers.length > 0) {
        mirrorToServers(url, mirrorServers, user.signer).catch(() => {
          // Mirroring is best-effort — don't fail the upload if it fails.
        });
      }

      return tags;
    },
  });
}

/**
 * Ask the target servers whether they'll take a blob (BUD-06) before preparing it; resolves to
 * the refusal when every server refuses — see `preflightRefusal`.
 */
export function useUploadPreflight() {
  const { config } = useAppContext();
  const { appBlossomServers, blossomServerMetadata, useAppBlossomServers } = config;
  return useCallback(
    (req: PreflightRequest, signal?: AbortSignal) =>
      preflightRefusal(
        getEffectiveBlossomServers(appBlossomServers, blossomServerMetadata, useAppBlossomServers),
        req,
        { signal },
      ),
    [appBlossomServers, blossomServerMetadata, useAppBlossomServers],
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
      // `t=mirror` events got 403s from conforming servers.
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
