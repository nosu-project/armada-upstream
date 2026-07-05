import { Capacitor } from "@capacitor/core";
import { createRoot } from "react-dom/client";

import { ErrorBoundary } from "@/components/ErrorBoundary";

import App from "./App.tsx";
import "./index.css";

// Mark the native (Capacitor APK) runtime on <html> so CSS can switch off
// web-isms (text selection, tap highlight, document overscroll/bounce) that
// make the app feel like a web page in a box. Web/PWA keeps the defaults.
if (Capacitor.isNativePlatform()) {
  document.documentElement.classList.add("native");
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);

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
