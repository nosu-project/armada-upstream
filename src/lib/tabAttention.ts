export const TAB_ATTENTION_PREFIX = "● ";

function isTabActive(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/** Add a compact unread marker to the browser-tab title when Armada is away. */
export function markTabAttention(): boolean {
  if (typeof document === "undefined" || isTabActive()) return false;
  if (!document.title.startsWith(TAB_ATTENTION_PREFIX)) {
    document.title = `${TAB_ATTENTION_PREFIX}${document.title}`;
  }
  return true;
}

export function clearTabAttention(): void {
  if (typeof document === "undefined") return;
  if (document.title.startsWith(TAB_ATTENTION_PREFIX)) {
    document.title = document.title.slice(TAB_ATTENTION_PREFIX.length);
  }
}

/** Clear the marker only after this tab is both visible and focused. */
export function installTabAttentionClearHandlers(): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") return () => {};

  const clearWhenActive = () => {
    if (isTabActive()) clearTabAttention();
  };
  document.addEventListener("visibilitychange", clearWhenActive);
  window.addEventListener("focus", clearWhenActive);

  return () => {
    document.removeEventListener("visibilitychange", clearWhenActive);
    window.removeEventListener("focus", clearWhenActive);
    clearTabAttention();
  };
}
