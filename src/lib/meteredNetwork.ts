/**
 * Whether the device is on a metered connection, from the Network Information
 * API (Chromium, including Android System WebView). Where the API is absent
 * (Safari, WKWebView, Firefox) the answer is "unmetered": this only gates
 * deferrable work, and a guess of "metered" would stop it everywhere.
 */

interface NetworkInformationLike extends EventTarget {
  type?: string;
  saveData?: boolean;
}

const METERED_TYPES = new Set(["cellular", "bluetooth", "wimax"]);

function connection(): NetworkInformationLike | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
}

export function isMeteredNetwork(): boolean {
  const info = connection();
  if (!info) return false;
  return info.saveData === true || (info.type !== undefined && METERED_TYPES.has(info.type));
}

/** Subscribe to connection changes. Returns an unsubscribe. */
export function onMeteredNetworkChange(listener: () => void): () => void {
  const info = connection();
  if (!info || typeof info.addEventListener !== "function") return () => {};
  info.addEventListener("change", listener);
  return () => info.removeEventListener("change", listener);
}
