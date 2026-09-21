import { useContext, useMemo } from "react";

import { AppContext, defaultConfig } from "@/contexts/AppContext";
import {
  mediaSrc,
  parseProxyList,
  type MediaPolicy,
  type MediaPolicyConfig,
} from "@/lib/mediaPolicy";

/**
 * The proxies the viewer added (`AppConfig.mediaProxies`), normalized, deduped
 * and capped (see `parseProxyList`). Reads the context directly rather than
 * through `useAppContext`: this sits under every avatar, and an avatar renders
 * wherever one does, provider or not — with no config in reach the app default
 * applies (proxying OFF), which is what a fresh install has.
 */
function useProxyPool(): readonly string[] {
  const config = useContext(AppContext)?.config;
  const list = config?.mediaProxies ?? defaultConfig.mediaProxies;
  return useMemo(() => parseProxyList(list.join("\n")), [list]);
}

/**
 * The viewer's media policy (see `lib/mediaPolicy.ts`), memoized so every
 * image on screen shares one object. The primary proxy is the first entry the
 * viewer entered; empty (nothing entered) is proxying off. This is the
 * single-value floor the one-image sites and the native writers read — it does
 * not rotate; {@link useMediaProxyRotation} carries the whole pool.
 */
export function useMediaPolicy(): MediaPolicy {
  const pool = useProxyPool();
  const proxy = pool[0] ?? "";
  return useMemo(() => ({ proxy }), [proxy]);
}

/**
 * The same policy in its bridge shape (see `MediaPolicyConfig`), for the hooks
 * that write the background writers' configs. Memoized on content. Carries the
 * primary proxy ONLY — the native writers do not rotate — so the rotation pool
 * stays a web-client concern.
 */
export function useMediaPolicyConfig(): MediaPolicyConfig {
  const policy = useMediaPolicy();
  return useMemo(() => ({ proxy: policy.proxy }), [policy]);
}

/**
 * The viewer's media policy with its rotation pool resolved (see
 * `MediaPolicy.proxies`). With more than one proxy entered, the whole set is the
 * pool the web fallback path (`useRoutedCandidates`) rotates across and falls
 * through on failure; with one (or none) the single {@link useMediaPolicy}
 * primary stands alone. Proxying off short-circuits either way.
 */
export function useMediaProxyRotation(): MediaPolicy {
  const pool = useProxyPool();
  return useMemo(() => {
    if (pool.length === 0) return { proxy: "" };
    if (pool.length === 1) return { proxy: pool[0] };
    return { proxy: pool[0], proxies: pool };
  }, [pool]);
}

/**
 * The `src` to load `url` from under the viewer's policy, or undefined when it
 * must not be loaded: for the one-image sites with no room for a placeholder
 * (a CSS background, a banner, a call backdrop), which show nothing rather than
 * fetch a loopback address or render an unproxied URL where a proxy is set.
 */
export function useMediaSrc(url: string | undefined): string | undefined {
  const policy = useMediaPolicy();
  return useMemo(() => mediaSrc(url, policy), [url, policy]);
}
