import { useContext, useMemo } from "react";

import { AppContext, defaultConfig } from "@/contexts/AppContext";
import {
  mediaSrc,
  normalizeMediaProxy,
  type MediaPolicy,
  type MediaPolicyConfig,
} from "@/lib/mediaPolicy";

/**
 * The viewer's media policy (see `lib/mediaPolicy.ts`), memoized so every
 * image on screen shares one object. Reads the context directly rather than
 * through `useAppContext`: this sits under every avatar, and an avatar renders
 * wherever one does, provider or not — with no config in reach the default
 * proxy applies, which is what a fresh install has.
 */
export function useMediaPolicy(): MediaPolicy {
  const config = useContext(AppContext)?.config;
  const proxy = normalizeMediaProxy(config?.mediaProxy ?? defaultConfig.mediaProxy);
  return useMemo(() => ({ proxy }), [proxy]);
}

/**
 * The same policy in its bridge shape (see `MediaPolicyConfig`), for the hooks
 * that write the background writers' configs. Memoized on content.
 */
export function useMediaPolicyConfig(): MediaPolicyConfig {
  const policy = useMediaPolicy();
  return useMemo(() => ({ proxy: policy.proxy }), [policy]);
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
