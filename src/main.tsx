// FIRST: AbortSignal.any/.timeout polyfills for pre-Chromium-116 WebViews;
// must precede every other import.
import "./polyfills";
// SECOND: profiler probes wrapping WebSocket/timers/DevTools hook; must load
// before react-dom and any socket-opening module.
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
// Installs `window.__armadaDbCensus()` (diagnostics reachable on-device).
import "@/lib/db/dbCensus";

import App from "./App.tsx";
import "./index.css";

// Electron/Linux PipeWire audio bridge for getDisplayMedia; install before LiveKit.
installDesktopDisplayMediaAudio();

// restrictOwnAudio on screen-share audio (Chrome 141+). Must wrap AFTER the
// desktop wrapper so it's outermost.
installScreenShareAudioRestriction();

// Tray-closed desktop windows keep the renderer running; pause media.
installEmbedPause();

// Electron shows no full-screen exit hint of its own.
installFullscreenHint();

// Native: CSS switches off web-isms (selection, tap highlight, overscroll).
if (Capacitor.isNativePlatform()) {
  document.documentElement.classList.add("native");
}

// WebKit bug: iOS home-screen PWAs can stay scrolled after the keyboard
// dismisses; snap back on focus loss.
if (document.documentElement.classList.contains("standalone")) {
  window.addEventListener("focusout", () => {
    window.scrollTo(0, 0);
  });
}

// Request durable storage: WebKit (esp. iOS PWAs) may evict IndexedDB,
// dropping decrypted DM stores. Skipped on Android, whose store is native SQLite.
if (Capacitor.getPlatform() !== "android" && navigator.storage?.persist) {
  void navigator.storage
    .persisted()
    .then((already) => (already ? undefined : navigator.storage.persist()))
    .catch(() => {});
}

persistVerifiedIds(() => getArmadaDB().kv);

// Before render so lag during mount is sampled too.
startLoopLagSampler();

perfMark("react render() called");

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);

// Signal first paint to the Android splash and the desktop shell.
signalWebReady();
signalDesktopWebReady();
// Let the desktop shell route clicks on our share links in-app.
try {
  registerDesktopDeepLinkHost(new URL(PUBLIC_WEB_ORIGIN).hostname);
} catch {
  // unparseable PUBLIC_WEB_ORIGIN: links open in the browser
}

perfMark("react mounted");

// Mounted without a stale-chunk crash: re-arm reload recovery for later deploys.
requestAnimationFrame(() => clearChunkReloadGuard());

// Vite's modulepreload failure (bypasses lazyWithReload): same one-shot stale-build reload.
window.addEventListener("vite:preloadError", (event) => {
  if (tryChunkReload()) event.preventDefault();
});

// Service worker is Web Push only — it must NOT cache the app shell (a stale
// shell survives chunk-error recovery).
if ("serviceWorker" in navigator) {
  if (Capacitor.isNativePlatform()) {
    // Native: push is native and SWs persist across updates, so unregister any
    // leftovers (incl. the old caching SW) and drop their shell caches.
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
    // Register immediately so VAPID is ready for a gesture-bound opt-in. The
    // build stamp busts CDN caching of /sw.js.
    const buildStamp = document.querySelector<HTMLMetaElement>('meta[name="build"]')?.content;
    const serviceWorkerUrl = buildStamp
      ? `/sw.js?v=${encodeURIComponent(buildStamp)}`
      : "/sw.js";
    navigator.serviceWorker
      .register(serviceWorkerUrl, { scope: "/", updateViaCache: "none" })
      .catch((err) => {
        console.warn("[sw] registration failed:", err);
      });

    // Once the app is open it owns unread state: clear the OS badge and worker counter.
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
