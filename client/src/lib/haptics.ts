/**
 * Haptics shims (web-only build).
 *
 * Ditto routes these through Capacitor on native; Armada is a web app, so we
 * use the Vibration API when present and otherwise no-op.
 */

export function selectionChanged(): void {
  try {
    navigator.vibrate?.(10);
  } catch {
    // Vibration API unavailable — no-op.
  }
}
