// FIRST: fills in AbortSignal.any / .timeout on WebViews that predate them
// (Android System WebView before Chromium 116). Must precede every other
// import so the statics exist before any module that reads them evaluates.
import "./polyfills";
// SECOND: the steady-state profiler's probes wrap WebSocket and the timers, and
// stand in for the React DevTools hook — all of which must exist before
// react-dom and the first socket-opening module evaluate.
import "@/lib/perfRuntimeInstall";

import { Capacitor } from "@capacitor/core";
import { createRoot } from "react-dom/client";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { clearChunkReloadGuard, tryChunkReload } from "@/lib/chunkReload";
import {
  installDesktopDisplayMediaAudio,
  registerDesktopDeepLinkHost,
  signalDesktopWebReady,
} from "@/lib/desktop";
import { installEmbedPause } from "@/lib/embedPause";
import { installFullscreenHint } from "@/lib/fullscreenHint";
import { installScreenShareAudioRestriction } from "@/lib/screenShareAudioRestriction";
import { PUBLIC_WEB_ORIGIN } from "@/lib/shareOrigin";
import { signalWebReady } from "@/lib/webReady";
import { perfMark, startLoopLagSampler } from "@/lib/perf";
import { getArmadaDB } from "@/lib/db/armadaDB";
import { persistVerifiedIds } from "@/lib/verifyCache";
// Side-effect import: installs `window.__armadaDbCensus()`, the read-only store
// census. Diagnostics have to be reachable from a console on the device that's
// slow, not only from a dev build.
import "@/lib/db/dbCensus";

import App from "./App.tsx";
import "./index.css";

// Electron/Linux cannot put PipeWire audio directly on getDisplayMedia's
// stream. Install the desktop bridge before LiveKit can request a share; this
// is a no-op in browsers and native mobile builds.
installDesktopDisplayMediaAudio();

// Keep a screen share's captured system audio from echoing the call back to it:
// wrap getDisplayMedia so an audio capture carries restrictOwnAudio (Chrome
// 141+; ignored elsewhere). AFTER the desktop wrapper above so this one is
// outermost and the venmic path it delegates to still runs unchanged.
installScreenShareAudioRestriction();

// Closing the desktop window to the tray keeps the renderer running; stop
// playing media and embeds so nothing plays on with no window to stop it from.
installEmbedPause();

// Electron shows no "Press Esc to exit full screen" of its own; show ours when
// an embed takes the window full-screen.
installFullscreenHint();

// Mark the native (Capacitor APK) runtime on <html> so CSS can switch off
// web-isms (text selection, tap highlight, document overscroll/bounce) that
// make the app feel like a web page in a box. Web/PWA keeps the defaults.
if (Capacitor.isNativePlatform()) {
  document.documentElement.classList.add("native");
}

// iOS home-screen PWAs can leave the layout viewport scrolled after the
// on-screen keyboard dismisses (WebKit bug): the whole app stays shifted up,
// leaving a dead band above the home indicator. The shell is scroll-locked in
// CSS (html.standalone, set in index.html); snap back on focus loss as well in
// case WebKit still nudges the visual viewport.
if (document.documentElement.classList.contains("standalone")) {
  window.addEventListener("focusout", () => {
    window.scrollTo(0, 0);
  });
}

// Ask the browser to keep our site storage DURABLE. Without a persistence
// grant, WebKit (notably iOS home-screen PWAs) treats IndexedDB as best-effort
// and may evict it when the app is terminated — silently dropping the decrypted
// NIP-17 rumor store (armada-dm17-rumors) and the kind-4 snapshots. A received
// conversation then reads fine in-session but vanishes on the next cold launch.
// Installed PWAs are typically granted automatically.
//
// Skipped on ANDROID specifically, not on native: Android is where the store is
// a native SQLite file (NativeArmadaDB → ArmadaDb plugin), so there is no
// IndexedDB quota to defend. iOS has no such plugin and falls through to
// IndexedDBArmadaDB inside WKWebView, so it wants the grant like any other
// WebKit target. (Desktop already reaches this: Electron is not a Capacitor
// native platform, and the request is harmless where the store is a file.)
if (Capacitor.getPlatform() !== "android" && navigator.storage?.persist) {
  void navigator.storage
    .persisted()
    .then((already) => (already ? undefined : navigator.storage.persist()))
    .catch(() => {});
}

// Signature verdicts outlive the session, so a relaunch doesn't re-prove the
// profiles, lists and sealed messages the last one already verified. The store
// is resolved lazily: this opens nothing until the first verify.
persistVerifiedIds(() => getArmadaDB().kv);

// Started before render so the sampler covers the mount itself: if the loop is
// blocked, every storage latency in the report is inflated by exactly this.
startLoopLagSampler();

perfMark("react render() called");

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);

// Tell the native launch splash the web layer has painted, so it lifts onto
// real content instead of a blank WebView frame (Android only; no-op elsewhere).
signalWebReady();
// The same fact for the desktop shell, which uses it to tell a bundle that
// boots from one that does not (no-op on web and mobile).
signalDesktopWebReady();
// Teach the desktop shell the host our shareable links are built on, so a
// copied message/invite link clicked inside the app lands in the router rather
// than the system browser (no-op on web and mobile). Send the bare hostname,
// which is what the shell compares against; a parse failure just leaves the
// old browser behavior in place.
try {
  registerDesktopDeepLinkHost(new URL(PUBLIC_WEB_ORIGIN).hostname);
} catch {
  // An unparseable VITE_PUBLIC_WEB_ORIGIN; the link opens in the browser as before.
}

// After render() returns, so the inline boot splash in index.html has been
// replaced. Everything between this and the first timeline paint is React,
// storage and crypto — which is the window the profile exists to explain.
perfMark("react mounted");

// The tree mounted without a stale-chunk crash: clear the one-time reload guard
// so a LATER deploy in this same session can recover again.
requestAnimationFrame(() => clearChunkReloadGuard());

// Vite emits this event when a preloaded dependency of a dynamic import fails
// to fetch (the modulepreload path, which bypasses lazyWithReload). Same
// stale-build recovery: one hard reload; preventDefault suppresses the throw
// that would otherwise bubble into the boundary during the reload.
window.addEventListener("vite:preloadError", (event) => {
  if (tryChunkReload()) event.preventDefault();
});

// Service worker: Web Push only — it must NOT cache or serve the app shell
// (a stale SW-cached shell after a release survives even the one-time
// chunk-error recovery reload and boots straight into the error screen).
if ("serviceWorker" in navigator) {
  if (Capacitor.isNativePlatform()) {
    // The APK's WebView resolves SW requests through Capacitor's local server
    // and persists registrations across app updates, so a SW is pure risk
    // here — push is native, the shell is local. Unregister anything left
    // behind by older releases (including the old caching SW) and drop its
    // shell caches so a poisoned install heals on this launch.
    navigator.serviceWorker
      .getRegistrations()
      .then((regs) => Promise.all(regs.map((reg) => reg.unregister())))
      .catch(() => {});
    if ("caches" in window) {
      caches
        .keys()
        .then((keys) =>
          Promise.all(keys.filter((k) => k.startsWith("armada-shell-")).map((k) => caches.delete(k))),
        )
        .catch(() => {});
    }
  } else {
    // Web: register immediately so the worker is active and its VAPID key can
    // be prepared before a gesture-bound notification opt-in. Waiting for the
    // load event could leave a fast onboarding tap with no ready worker.
    // Include the build stamp in the script URL because the hosted CDN can
    // cache /sw.js longer than the origin requests. A new URL per deployment
    // makes the updated push worker available immediately instead of waiting
    // for an edge-cache entry to expire.
    const buildStamp = document.querySelector<HTMLMetaElement>('meta[name="build"]')?.content;
    const serviceWorkerUrl = buildStamp
      ? `/sw.js?v=${encodeURIComponent(buildStamp)}`
      : "/sw.js";
    navigator.serviceWorker
      .register(serviceWorkerUrl, { scope: "/", updateViaCache: "none" })
      .catch((err) => {
        console.warn("[sw] registration failed:", err);
      });

    // A Home-Screen badge is useful while Armada is closed, but once the user
    // returns the app itself is the source of truth for unread state. Clear the
    // OS badge and the worker's persisted counter on launch/focus.
    const clearWebAppBadge = () => {
      if (document.visibilityState !== "visible") return;
      const badgeNavigator = navigator as Navigator & { clearAppBadge?: () => Promise<void> };
      void badgeNavigator.clearAppBadge?.().catch(() => {});
      const clearWorkerCounter = (worker?: ServiceWorker | null) => {
        worker?.postMessage({ type: "armada-clear-badge" });
      };
      if (navigator.serviceWorker.controller) {
        clearWorkerCounter(navigator.serviceWorker.controller);
      } else {
        void navigator.serviceWorker.ready
          .then((registration) => clearWorkerCounter(registration.active))
          .catch(() => {});
      }
    };
    clearWebAppBadge();
    document.addEventListener("visibilitychange", clearWebAppBadge);
  }
}
