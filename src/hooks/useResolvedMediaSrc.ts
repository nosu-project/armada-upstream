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

/** A possibly-encrypted media reference resolved for display. */
export interface EncryptedRef {
  url: string;
  encryption?: ImetaEncryption;
  mime?: string;
  /**
   * Alternative sources for the same bytes, from the imeta `fallback` field.
   * Tried after `url` by {@link useMediaWithFallback}; per NIP-17 they are
   * encrypted under the same key and nonce, so `encryption` covers them too.
   */
  fallbacks?: string[];
  /** NIP-94 `dim` hint ("WxH") — sizes placeholders before load (display only). */
  dim?: string;
  /** NIP-94 `blurhash` hint — blur-up placeholder before load (display only). */
  blurhash?: string;
}

type State =
  | { status: "ready"; src: string }
  | { status: "loading" }
  /** Past the inline decrypt cap — retryable with a bigger budget, unlike "error". */
  | { status: "oversized"; byteSize: number }
  | { status: "error" };

/**
 * Settle on a `src`, keeping the previous state object when it already names
 * it. A fresh `{ status: "ready", src }` is never `Object.is`-equal to the last
 * one, so setting it unconditionally commits a render per resolve that changes
 * nothing — including the one the synchronous cache seed exists to avoid, since
 * the first effect after a warm mount resolves to the src already on screen.
 */
function ready(src: string) {
  return (prev: State): State => (prev.status === "ready" && prev.src === src ? prev : { status: "ready", src });
}

/**
 * Resolve a media URL to a displayable `src`. For plain URLs this is the URL
 * itself; for client-encrypted Blossom attachments (Vector/0xChat `imeta`
 * with `decryption-key`/`decryption-nonce`) it fetches and AES-GCM-decrypts
 * the blob into an object URL.
 *
 * Returns `status: "loading"` while decrypting, `"ready"` with the `src`,
 * `"oversized"` when the blob is past `maxBytes`, or `"error"` on failure (so
 * callers can fall back to a placeholder).
 *
 * An attachment that declares an encryption we CAN'T apply — an algorithm we
 * don't implement, a malformed key — resolves to `"error"`, never to its own
 * URL. Falling back to the URL there would paint ciphertext into an `<img>`,
 * which is worse than a placeholder in every way: it can't succeed, and it
 * leaks a fetch of a blob the user was never able to open.
 */
export function useResolvedMediaSrc(
  ref: EncryptedRef | string,
  opts: {
    maxBytes?: number;
    /**
     * Other hosts holding the same ciphertext, tried in order INSIDE one
     * resolve when the primary fails (see `decryptAttachmentToObjectURL`). Only
     * the encrypted path fetches, so only it walks these; a plain URL is walked
     * by the element that renders it.
     */
    alternates?: readonly string[];
    /** Bump to re-run a resolve whose inputs are unchanged — the manual retry. */
    retryKey?: number;
  } = {},
): State {
  const url = typeof ref === "string" ? ref : ref.url;
  const encryption = typeof ref === "string" ? undefined : ref.encryption;
  const mime = typeof ref === "string" ? undefined : ref.mime;
  const { maxBytes } = opts;
  // Content identity: callers rebuild the array every render, and a URL cannot
  // contain a newline.
  const alternatesKey = opts.alternates?.join("\n") ?? "";
  const retryKey = opts.retryKey ?? 0;

  // Key the effect on primitive identity only. Callers commonly pass a fresh
  // `EncryptedRef`/`encryption` object every render (tokens are rebuilt on each
  // ChatContent render), so depending on the object identity would re-run the
  // effect — and thus setState — on every render, causing a render loop.
  const encKey = encryption?.key;
  const encNonce = encryption?.nonce;
  const encAlgo = encryption?.algorithm;
  const encOx = encryption?.ox;
  // Whether the blob is ciphertext at all, vs whether we can read it — an
  // attachment that is the first but not the second must not be treated as
  // plaintext. `undefined` (no `encryption-algorithm` at all) is the only
  // spelling of "not encrypted".
  const encrypted = Boolean(encAlgo);
  const decryptable = isSupportedEncryption(encryption);

  // Re-evaluate Buzz-ness when the host registry grows (a URL whose relay's
  // NIP-11 hadn't resolved yet becomes authenticable once its host registers).
  useSyncExternalStore(subscribeBuzzMediaHosts, getBuzzMediaHostsVersion);
  // A Buzz-hosted blob needs a signed GET header (see @/buzz/media); the
  // encrypted path already fetches with its own key, so Buzz auth is only for
  // the non-encrypted case.
  const needsBuzzAuth = !encrypted && isBuzzMediaUrl(url);

  // Seed from the decrypted-attachment cache SYNCHRONOUSLY when it holds these
  // bytes. `decryptAttachmentToObjectURL` returns a cached promise on a hit,
  // but a promise can only deliver in a microtask, so waiting on it costs a
  // placeholder commit and a post-load height change per attachment — on every
  // channel switch, for blobs that never left memory.
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
      // Encrypted with something we can't apply. Fail closed — never fall
      // through to the plain-URL branch below, which would render ciphertext.
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
          // Fall back to the plain URL (it will 401, but that's no worse than
          // before, and lets a public/unauth'd host still render).
          if (!cancelled) setState(ready(url));
        });
      return () => {
        cancelled = true;
        controller.abort();
      };
    }
    const enc = { algorithm: encAlgo!, key: encKey!, nonce: encNonce!, ox: encOx };
    // Same cache check as the initializer, for the re-runs it can't cover (the
    // url or its crypto params changed). Announcing `loading` before looking
    // would undo the synchronous seed on the first effect after mount.
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
        // Too big is not the same as broken: the caller can offer to spend the
        // memory rather than showing an unavailable placeholder.
        setState(
          e instanceof FileTooLargeError ? { status: "oversized", byteSize: e.byteSize } : { status: "error" },
        );
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // Re-resolve only when the blob URL or its crypto params actually change.
  }, [url, encrypted, decryptable, encKey, encNonce, encAlgo, encOx, mime, needsBuzzAuth, maxBytes, alternatesKey, retryKey]);

  return state;
}
