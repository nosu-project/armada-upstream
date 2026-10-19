import { useSyncExternalStore } from "react";

import { detectLocale, isSupportedLocale, type LocaleCode } from "@/i18n/locales";

/**
 * The interface language. Device-wide rather than in the per-account AppConfig,
 * like the text size: the login screen needs it too, and it survives logout.
 * Absent means "follow the browser/OS".
 */
export const LOCALE_KEY = "armada:locale";

function readChoice(): LocaleCode | null {
  try {
    const stored = localStorage.getItem(LOCALE_KEY);
    return isSupportedLocale(stored) ? stored : null;
  } catch {
    return null;
  }
}

let choice = readChoice();
const listeners = new Set<() => void>();

/** The explicit choice, or null when following the system. */
export function getLanguageChoice(): LocaleCode | null {
  return choice;
}

/** The language the interface should be in now. */
export function getPreferredLocale(): LocaleCode {
  return choice ?? detectLocale();
}

/** Pick a language, or `null` to follow the browser/OS again. */
export function setLanguageChoice(next: LocaleCode | null): void {
  if (next === choice) return;
  choice = next;
  try {
    if (next) localStorage.setItem(LOCALE_KEY, next);
    else localStorage.removeItem(LOCALE_KEY);
  } catch {
    // Private-mode/quota: the choice still holds for this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // The OS language can change under a "system" choice.
  window.addEventListener("languagechange", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("languagechange", listener);
  };
}

export function useLanguageChoice(): LocaleCode | null {
  return useSyncExternalStore(subscribe, getLanguageChoice);
}

export function usePreferredLocale(): LocaleCode {
  return useSyncExternalStore(subscribe, getPreferredLocale);
}
