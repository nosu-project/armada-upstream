import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FormattedMessage, t, useIntl } from "@/i18n";
import { I18nProvider } from "@/i18n/I18nProvider";
import { LOCALE_KEY, setLanguageChoice } from "@/i18n/language";
import { detectLocale, formattingLocale, loadCatalog, notificationLocale } from "@/i18n/locales";

import de from "./locales/de.json";
import en from "./locales/en.json";

function Probe() {
  const intl = useIntl();
  return (
    <div>
      <span data-testid="jsx"><FormattedMessage id="settings.language.label" defaultMessage="Language" /></span>
      <span data-testid="hook">{intl.formatMessage({ id: "settings.language.system", defaultMessage: "System default" })}</span>
      <span data-testid="t">{t({ id: "settings.language.label", defaultMessage: "Language" })}</span>
    </div>
  );
}

afterEach(() => {
  setLanguageChoice(null);
  localStorage.removeItem(LOCALE_KEY);
});

describe("detectLocale", () => {
  it("takes the first supported base language", () => {
    expect(detectLocale(["zh-TW", "de-AT", "fr"])).toBe("de");
    expect(detectLocale(["pt-BR"])).toBe("pt");
    expect(detectLocale(["ja-JP"])).toBe("ja");
  });

  it("falls back to English", () => {
    expect(detectLocale(["ko-KR", "zh"])).toBe("en");
    expect(detectLocale([])).toBe("en");
  });
});

describe("formattingLocale", () => {
  it("keeps the region of a preference in the same language", () => {
    expect(formattingLocale("en", ["en-GB", "en-US"])).toBe("en-GB");
    expect(formattingLocale("de", ["fr-FR", "de-AT"])).toBe("de-AT");
    expect(formattingLocale("ja", ["ja"])).toBe("ja");
  });

  it("borrows the first region when no preference is in the language", () => {
    expect(formattingLocale("en", ["pt-BR", "ru-RU"])).toBe("en-BR");
    expect(formattingLocale("en", ["pt"])).toBe("en");
    expect(formattingLocale("en", ["not a tag"])).toBe("en");
  });
});

describe("I18nProvider", () => {
  it("renders English without a provider", () => {
    render(<Probe />);
    expect(screen.getByTestId("jsx").textContent).toBe("Language");
    expect(screen.getByTestId("hook").textContent).toBe("System default");
  });

  it("switches language, and t() follows it", async () => {
    await loadCatalog("de");
    render(<I18nProvider><Probe /></I18nProvider>);
    expect(screen.getByTestId("jsx").textContent).toBe(en["settings.language.label"]);

    act(() => setLanguageChoice("de"));
    expect(localStorage.getItem(LOCALE_KEY)).toBe("de");
    expect(screen.getByTestId("jsx").textContent).toBe((de as Record<string, string>)["settings.language.label"]);
    expect(screen.getByTestId("t").textContent).toBe((de as Record<string, string>)["settings.language.label"]);
    expect(document.documentElement.lang).toBe("de");
  });

  it("keys notifier catalogs by language, not region", async () => {
    await loadCatalog("de");
    expect(notificationLocale("de-AT")?.locale).toBe("de");
  });
});
