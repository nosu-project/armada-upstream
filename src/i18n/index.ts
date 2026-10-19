import { Children, createElement, Fragment, useContext, type ComponentProps, type ReactNode } from "react";
import {
  createIntl as createReactIntl,
  IntlContext,
  type FormattedMessage as ReactIntlFormattedMessage,
  type IntlShape as ReactIntlShape,
} from "react-intl";

export {
  createAppIntl,
  defineMessage,
  defineMessages,
  getIntl,
  getLanguage,
  getLocale,
  languageOf,
  t,
  type MessageDescriptor,
  type PrimitiveType,
} from "@/i18n/intl";
export { common } from "@/i18n/common";
export { LANGUAGE_OPTIONS, type LocaleCode } from "@/i18n/locales";
export type { IntlShape } from "react-intl";

/** English, for a render outside `I18nProvider` (tests, the outermost ErrorBoundary). */
let fallback: ReactIntlShape | undefined;

function fallbackIntl(): ReactIntlShape {
  fallback ??= createReactIntl({ locale: "en", defaultLocale: "en", onError: () => {} });
  return fallback;
}

/** `react-intl`'s `useIntl`, but English instead of a throw when no provider is mounted. */
export function useIntl(): ReactIntlShape {
  return useContext(IntlContext) ?? fallbackIntl();
}

type FormattedMessageProps = ComponentProps<typeof ReactIntlFormattedMessage>;

/** `<FormattedMessage>` on top of {@link useIntl}, so it renders without a provider too. */
export function FormattedMessage({ values, children, ...descriptor }: FormattedMessageProps) {
  const intl = useIntl();
  const formatted = intl.formatMessage(descriptor, values as Record<string, ReactNode>);
  const nodes = Array.isArray(formatted) ? formatted : [formatted];
  if (typeof children === "function") return children(nodes);
  return createElement(Fragment, null, ...Children.toArray(nodes));
}
