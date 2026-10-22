import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { defineMessages, FormattedMessage, useIntl, type MessageDescriptor } from "@/i18n";
import { loadThemeFont } from "@/lib/fontLoader";
import { themeFontOptions, type ThemeFontCategory } from "@/lib/themeFonts";

const CATEGORY_LABELS: Record<ThemeFontCategory, MessageDescriptor> = defineMessages({
  sans: { id: "themeFontFields.category.sans", defaultMessage: "Sans serif" },
  serif: { id: "themeFontFields.category.serif", defaultMessage: "Serif" },
  mono: { id: "themeFontFields.category.mono", defaultMessage: "Monospace" },
  display: { id: "themeFontFields.category.display", defaultMessage: "Display" },
  handwriting: { id: "themeFontFields.category.handwriting", defaultMessage: "Handwriting" },
});

const FONT_CATEGORIES: ThemeFontCategory[] = ["sans", "serif", "mono", "display", "handwriting"];

/** Radix Select forbids an empty-string value. */
const DEFAULT_FONT = "__default__";

function FontSelect({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (family: string) => void;
  placeholder: string;
}) {
  return (
    <div className="flex-1 space-y-1.5 min-w-0">
      <Label htmlFor={id} className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </Label>
      <Select value={value || DEFAULT_FONT} onValueChange={(v) => onChange(v === DEFAULT_FONT ? "" : v)}>
        <SelectTrigger id={id}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_FONT}>{placeholder}</SelectItem>
          {FONT_CATEGORIES.map((cat) => (
            <SelectGroup key={cat}>
              <SelectLabel>
                <FormattedMessage {...CATEGORY_LABELS[cat]} />
              </SelectLabel>
              {themeFontOptions
                .filter((f) => f.category === cat)
                .map((f) => (
                  <SelectItem
                    key={f.family}
                    value={f.family}
                    style={{ fontFamily: loadThemeFont({ family: f.family }) }}
                  >
                    {f.family}
                  </SelectItem>
                ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Body and heading font pickers over the catalog Ditto shares. `""` is the default font. */
export function ThemeFontFields({
  font,
  onFontChange,
  titleFont,
  onTitleFontChange,
}: {
  font: string;
  onFontChange: (family: string) => void;
  titleFont: string;
  onTitleFontChange: (family: string) => void;
}) {
  const intl = useIntl();
  const defaultFont = intl.formatMessage({ id: "themeFontFields.defaultFont", defaultMessage: "Default" });
  return (
    <div className="flex gap-3">
      <FontSelect
        id="theme-font"
        label={intl.formatMessage({ id: "themeFontFields.font", defaultMessage: "Font" })}
        value={font}
        onChange={onFontChange}
        placeholder={defaultFont}
      />
      <FontSelect
        id="theme-title-font"
        label={intl.formatMessage({ id: "themeFontFields.nameFont", defaultMessage: "Name font" })}
        value={titleFont}
        onChange={onTitleFontChange}
        placeholder={font || defaultFont}
      />
    </div>
  );
}
