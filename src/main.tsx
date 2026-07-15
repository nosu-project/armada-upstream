import { Capacitor } from "@capacitor/core";
import { createRoot } from "react-dom/client";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { clearChunkReloadGuard } from "@/lib/chunkReload";
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

// Register the service worker for offline app-shell caching and Web Push.
// Best-effort: PWA install + push stays unavailable if registration fails or
// isn't supported (e.g. insecure origin, private browsing).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => {
      console.warn("[sw] registration failed:", err);
    });
  });
}
