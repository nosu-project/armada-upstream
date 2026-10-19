/** Languages with a bundled catalog, in picker order. English is the source language. */
export const LANGUAGE_OPTIONS = [
  { code: "en", nativeName: "English" },
  { code: "de", nativeName: "Deutsch" },
  { code: "es", nativeName: "Español" },
  { code: "fr", nativeName: "Français" },
  { code: "it", nativeName: "Italiano" },
  { code: "nl", nativeName: "Nederlands" },
  { code: "ja", nativeName: "日本語" },
] as const;

export type LocaleCode = (typeof LANGUAGE_OPTIONS)[number]["code"];

export const SUPPORTED_LOCALES: readonly LocaleCode[] = LANGUAGE_OPTIONS.map((l) => l.code);

export type Catalog = Record<string, string>;

/**
 * Lazily imported so each language is its own chunk. English needs none: its
 * text is the inline `defaultMessage` at every call site.
 */
const CATALOGS: Record<string, () => Promise<{ default: Catalog }>> = {
  de: () => import("./locales/de.json"),
  es: () => import("./locales/es.json"),
  fr: () => import("./locales/fr.json"),
  it: () => import("./locales/it.json"),
  nl: () => import("./locales/nl.json"),
  ja: () => import("./locales/ja.json"),
};

const loaded = new Map<string, Catalog>();
const pending = new Map<string, Promise<Catalog | undefined>>();

export function isSupportedLocale(code: string | null | undefined): code is LocaleCode {
  return !!code && (SUPPORTED_LOCALES as readonly string[]).includes(code);
}

export function hasCatalog(locale: string): boolean {
  return locale in CATALOGS;
}

/** A catalog whose chunk has already arrived. */
export function peekCatalog(locale: string): Catalog | undefined {
  return loaded.get(locale);
}

/** Fetch a locale's catalog chunk, once per page. */
export function loadCatalog(locale: string): Promise<Catalog | undefined> {
  const cached = loaded.get(locale);
  if (cached) return Promise.resolve(cached);
  const load = CATALOGS[locale];
  if (!load) return Promise.resolve(undefined);
  let inflight = pending.get(locale);
  if (!inflight) {
    inflight = load().then(
      ({ default: messages }) => {
        loaded.set(locale, messages);
        pending.delete(locale);
        return messages;
      },
      (err) => {
        // Let a later attempt retry a chunk that failed to load.
        pending.delete(locale);
        throw err;
      },
    );
    pending.set(locale, inflight);
  }
  return inflight;
}

/** The first supported language in the browser/OS preference list, else English. */
export function detectLocale(languages?: readonly string[]): LocaleCode {
  const prefs = languages
    ?? (typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]);
  for (const tag of prefs) {
    const base = tag?.toLowerCase().split("-")[0];
    if (isSupportedLocale(base)) return base;
  }
  return "en";
}

/**
 * The language a background notifier should word its text in, with the
 * `notification.*` messages it needs. Absent when the language is English or
 * its catalog isn't loaded, which the notifiers read as English.
 */
export function notificationLocale(locale: string): { locale: string; messages: Catalog } | undefined {
  const catalog = peekCatalog(locale);
  if (!catalog) return undefined;
  const messages: Catalog = {};
  for (const [id, text] of Object.entries(catalog)) {
    if (id.startsWith("notification.")) messages[id] = text;
  }
  return { locale, messages };
}
