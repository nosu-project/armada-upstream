import { Capacitor } from "@capacitor/core";
import { createRoot } from "react-dom/client";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { clearChunkReloadGuard, tryChunkReload } from "@/lib/chunkReload";
import { signalWebReady } from "@/lib/webReady";

import App from "./App.tsx";
import "./index.css";

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
// Installed PWAs are typically granted automatically; this is a no-op on the
// native (Capacitor) runtime, whose storage already survives across launches.
if (!Capacitor.isNativePlatform() && navigator.storage?.persist) {
  void navigator.storage
    .persisted()
    .then((already) => (already ? undefined : navigator.storage.persist()))
    .catch(() => {});
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);

// Tell the native launch splash the web layer has painted, so it lifts onto
// real content instead of a blank WebView frame (Android only; no-op elsewhere).
signalWebReady();

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
    // Web: best-effort registration for push; if it fails (insecure origin,
    // private browsing), push is simply unavailable.
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => {
        console.warn("[sw] registration failed:", err);
      });
    });
  }
}
