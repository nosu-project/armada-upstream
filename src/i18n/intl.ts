import {
  createIntl,
  createIntlCache,
  defineMessage,
  defineMessages,
  type IntlShape,
  type MessageDescriptor,
} from "@formatjs/intl";

import type { Catalog } from "@/i18n/locales";

/**
 * Framework-free half of i18n, safe in the service worker. The page's
 * `I18nProvider` installs its intl here, so code outside React (toasts, lib
 * helpers) formats in the active language through `t()`.
 */

export type { MessageDescriptor };
/** A value a message can interpolate (as in intl-messageformat). */
export type PrimitiveType = string | number | bigint | boolean | null | undefined | Date;
export { defineMessage, defineMessages };

const cache = createIntlCache();

export function createAppIntl(locale: string, messages?: Catalog): IntlShape {
  return createIntl(
    {
      locale,
      defaultLocale: "en",
      messages,
      onError: (err) => {
        // Catalogs lag the source between syncs; a missing id falls back to its English defaultMessage.
        if (err.code !== "MISSING_TRANSLATION") console.error(err);
      },
    },
    cache,
  );
}

let current: IntlShape = createAppIntl("en");

export function getIntl(): IntlShape {
  return current;
}

export function setIntl(next: IntlShape): void {
  current = next;
}

/** The active locale code, for `Intl.*` / `toLocale*String` calls outside React. */
export function getLocale(): string {
  return current.locale;
}

/**
 * Format a message in the active language. Read it when the text is SHOWN, not
 * at module load: a value computed once stays in the language of that moment.
 */
export function t(descriptor: MessageDescriptor, values?: Record<string, PrimitiveType>): string {
  return current.formatMessage(descriptor, values);
}
