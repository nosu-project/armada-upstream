import { useEffect, useState, useSyncExternalStore } from "react";

import {
  getBuzzMediaHostsVersion,
  isBuzzMediaUrl,
  resolveBuzzMediaObjectURL,
  subscribeBuzzMediaHosts,
} from "@/buzz/media";
import { decryptAttachmentToObjectURL, FileTooLargeError, peekAttachmentObjectURL } from "@/lib/encryptedMedia";
import { isSupportedEncryption } from "@/lib/imeta";

import type { ImetaEncryption } from "@/lib/imeta";

export interface EncryptedRef {
  url: string;
  encryption?: ImetaEncryption;
  mime?: string;
  /** Alternative sources from imeta `fallback`; per NIP-17 encrypted under the same key and nonce. */
  fallbacks?: string[];
  /** NIP-94 `dim` hint ("WxH"), display only. */
  dim?: string;
  /** NIP-94 `blurhash` hint, display only. */
  blurhash?: string;
}

type State =
  | { status: "ready"; src: string }
  | { status: "loading" }
  /** Past the inline decrypt cap — retryable with a bigger budget, unlike "error". */
  | { status: "oversized"; byteSize: number }
  | { status: "error" };

/** Reuse the previous state when it names the same src, avoiding a no-op render per resolve. */
function ready(src: string) {
  return (prev: State): State => (prev.status === "ready" && prev.src === src ? prev : { status: "ready", src });
}

/**
 * Plain URLs pass through; client-encrypted Blossom attachments (`decryption-key`/`-nonce`) are
 * fetched and AES-GCM-decrypted to an object URL. An encryption we can't apply resolves to "error",
 * never the raw URL (that would paint ciphertext and leak a fetch).
 */
export function useResolvedMediaSrc(
  ref: EncryptedRef | string,
  opts: {
    maxBytes?: number;
    /** Tried in order inside one resolve on primary failure; only the encrypted path walks these. */
    alternates?: readonly string[];
    /** Bump to re-run a resolve whose inputs are unchanged — the manual retry. */
    retryKey?: number;
  } = {},
): State {
  const url = typeof ref === "string" ? ref : ref.url;
  const encryption = typeof ref === "string" ? undefined : ref.encryption;
  const mime = typeof ref === "string" ? undefined : ref.mime;
  const { maxBytes } = opts;
  // Content identity; a URL cannot contain a newline.
  const alternatesKey = opts.alternates?.join("\n") ?? "";
  const retryKey = opts.retryKey ?? 0;

  // Primitive deps: callers pass fresh objects every render, which would loop.
  const encKey = encryption?.key;
  const encNonce = encryption?.nonce;
  const encAlgo = encryption?.algorithm;
  const encOx = encryption?.ox;
  // `undefined` algorithm is the only spelling of "not encrypted"; unreadable ciphertext is
  // not plaintext.
  const encrypted = Boolean(encAlgo);
  const decryptable = isSupportedEncryption(encryption);

  // Re-evaluate Buzz-ness when the host registry grows.
  useSyncExternalStore(subscribeBuzzMediaHosts, getBuzzMediaHostsVersion);
  // Buzz blobs need a signed GET header (see @/buzz/media); only for the non-encrypted case.
  const needsBuzzAuth = !encrypted && isBuzzMediaUrl(url);

  // Seed synchronously from the decrypted-attachment cache; a cached promise would still cost a
  // placeholder commit and a height change.
  const [state, setState] = useState<State>(() => {
    if (encrypted) {
      if (!decryptable) return { status: "error" };
      const cached = peekAttachmentObjectURL(url, encryption!);
      return cached ? { status: "ready", src: cached } : { status: "loading" };
    }
    return needsBuzzAuth ? { status: "loading" } : { status: "ready", src: url };
  });

  useEffect(() => {
    if (encrypted && !decryptable) {
      // Fail closed — never fall through to rendering ciphertext.
      setState({ status: "error" });
      return;
    }
    if (!encrypted) {
      if (!needsBuzzAuth) {
        setState(ready(url));
        return;
      }
      let cancelled = false;
      const controller = new AbortController();
      setState({ status: "loading" });
      resolveBuzzMediaObjectURL(url, controller.signal)
        .then((src) => {
          if (!cancelled) setState(ready(src));
        })
        .catch(() => {
          // Plain URL fallback (may 401, but a public host still renders).
          if (!cancelled) setState(ready(url));
        });
      return () => {
        cancelled = true;
        controller.abort();
      };
    }
    const enc = { algorithm: encAlgo!, key: encKey!, nonce: encNonce!, ox: encOx };
    // Check the cache before announcing `loading`, or the synchronous seed is undone.
    const cached = peekAttachmentObjectURL(url, enc);
    if (cached) {
      setState(ready(cached));
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setState({ status: "loading" });
    // `retryKey` is a dependency only: it exists to re-run this effect.
    void retryKey;
    decryptAttachmentToObjectURL(url, enc, mime, {
      signal: controller.signal,
      maxBytes,
      alternates: alternatesKey ? alternatesKey.split("\n") : undefined,
    })
      .then((src) => {
        if (!cancelled) setState(ready(src));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // Oversized isn't broken: the caller can offer to spend the memory.
        setState(
          e instanceof FileTooLargeError ? { status: "oversized", byteSize: e.byteSize } : { status: "error" },
        );
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [url, encrypted, decryptable, encKey, encNonce, encAlgo, encOx, mime, needsBuzzAuth, maxBytes, alternatesKey, retryKey]);

  return state;
}
