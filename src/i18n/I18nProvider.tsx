import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createIntl, RawIntlProvider, type IntlShape as ReactIntlShape } from "react-intl";

import { setIntl } from "@/i18n/intl";
import { usePreferredLocale } from "@/i18n/language";
import { formattingLocale, hasCatalog, loadCatalog, peekCatalog, type Catalog } from "@/i18n/locales";

interface Loaded {
  locale: string;
  messages?: Catalog;
}

/** Without waiting: English needs no catalog, or the chunk is already in. */
function resolveSync(locale: string): Loaded | null {
  if (!hasCatalog(locale)) return { locale };
  const messages = peekCatalog(locale);
  return messages ? { locale, messages } : null;
}

function buildIntl({ locale, messages }: Loaded): ReactIntlShape {
  return createIntl({
    locale: formattingLocale(locale),
    defaultLocale: "en",
    messages,
    onError: (err) => {
      // Catalogs lag the source between syncs; a missing id falls back to its English defaultMessage.
      if (err.code !== "MISSING_TRANSLATION") console.error(err);
    },
  });
}

/**
 * Feeds react-intl the preferred language, loading its catalog chunk on demand,
 * and installs the same intl for `t()` outside React.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const locale = usePreferredLocale();
  const [loaded, setLoaded] = useState<Loaded | null>(() => resolveSync(locale));

  useEffect(() => {
    if (loaded?.locale === locale) return;
    const sync = resolveSync(locale);
    if (sync) {
      setLoaded(sync);
      return;
    }
    // Keep the previous language on screen until the new catalog arrives.
    let cancelled = false;
    loadCatalog(locale)
      .then((messages) => {
        if (!cancelled) setLoaded({ locale, messages });
      })
      .catch(() => {
        // The chunk failed to load: English rather than nothing.
        if (!cancelled) setLoaded({ locale: "en" });
      });
    return () => {
      cancelled = true;
    };
  }, [locale, loaded]);

  const intl = useMemo(() => (loaded ? buildIntl(loaded) : null), [loaded]);
  // During render, so children formatting through `t()` see the same language.
  if (intl) setIntl(intl as unknown as Parameters<typeof setIntl>[0]);

  useEffect(() => {
    if (loaded) document.documentElement.lang = loaded.locale;
  }, [loaded]);

  // Only on the first paint of a translated language whose chunk isn't in yet;
  // main.tsx starts that fetch before React mounts.
  if (!intl) return null;
  return <RawIntlProvider value={intl}>{children}</RawIntlProvider>;
}
