import { SettingsRow } from "@/components/settings/SettingsSection";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormattedMessage, LANGUAGE_OPTIONS, useIntl, type LocaleCode } from "@/i18n";
import { setLanguageChoice, useLanguageChoice } from "@/i18n/language";

const SYSTEM = "system";

export function LanguageSettings() {
  const intl = useIntl();
  const choice = useLanguageChoice();
  const label = intl.formatMessage({ id: "settings.language.label", defaultMessage: "Language" });

  return (
    <SettingsRow
      label={label}
      description={
        <FormattedMessage
          id="settings.language.description"
          defaultMessage="The language of the app on this device."
        />
      }
    >
      <Select
        value={choice ?? SYSTEM}
        onValueChange={(value) => setLanguageChoice(value === SYSTEM ? null : (value as LocaleCode))}
      >
        <SelectTrigger className="w-40 sm:w-48" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={SYSTEM}>
            <FormattedMessage id="settings.language.system" defaultMessage="System default" />
          </SelectItem>
          {LANGUAGE_OPTIONS.map((lang) => (
            // Native names, so a user lost in a foreign language can still find their own.
            <SelectItem key={lang.code} value={lang.code} lang={lang.code}>
              {lang.nativeName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsRow>
  );
}
