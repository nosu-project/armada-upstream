import { useSyncExternalStore } from "react";

import type { ThemeConfig } from "@/themes";

/**
 * A theme the user is trying on. Memory only: nothing is stored or synced until
 * "Use this theme" in `ThemePreviewBar`.
 */
export interface ThemePreview {
  config: ThemeConfig;
}

let current: ThemePreview | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function startThemePreview(config: ThemeConfig): void {
  current = { config };
  emit();
}

export function clearThemePreview(): void {
  if (!current) return;
  current = null;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return current;
}

export function useThemePreview(): ThemePreview | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
