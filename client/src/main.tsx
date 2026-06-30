import { Capacitor } from "@capacitor/core";
import { createRoot } from "react-dom/client";

import App from "./App.tsx";
import "./index.css";

// Mark the native (Capacitor APK) runtime on <html> so CSS can switch off
// web-isms (text selection, tap highlight, document overscroll/bounce) that
// make the app feel like a web page in a box. Web/PWA keeps the defaults.
if (Capacitor.isNativePlatform()) {
  document.documentElement.classList.add("native");
}

createRoot(document.getElementById("root")!).render(<App />);

// Register the service worker that receives Web Push notifications. Best-effort:
// push simply stays unavailable if registration fails or isn't supported.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => {
      console.warn("[sw] registration failed:", err);
    });
  });
}
