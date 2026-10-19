import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FormattedMessage, t, useIntl } from "@/i18n";
import { I18nProvider } from "@/i18n/I18nProvider";
import { LOCALE_KEY, setLanguageChoice } from "@/i18n/language";
import { detectLocale, loadCatalog } from "@/i18n/locales";

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
    expect(detectLocale(["pt-BR", "de-AT", "fr"])).toBe("de");
    expect(detectLocale(["ja-JP"])).toBe("ja");
  });

  it("falls back to English", () => {
    expect(detectLocale(["pt-BR", "zh"])).toBe("en");
    expect(detectLocale([])).toBe("en");
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
});
