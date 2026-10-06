import { SettingsRow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  FONT_SCALE_DEFAULT,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  setFontScale,
  useFontScale,
} from "@/lib/fontScale";

export function FontScaleSettings() {
  const scale = useFontScale();

  return (
    <SettingsRow label="Text size" description="Scales text across the app on this device." stack>
      <div className="flex items-center gap-3 sm:w-72">
        <Slider
          min={FONT_SCALE_MIN}
          max={FONT_SCALE_MAX}
          step={5}
          value={[scale]}
          onValueChange={([v]) => setFontScale(v)}
          aria-label="Text size"
          aria-valuetext={`${scale}%`}
          className="flex-1 touch:py-3"
        />
        <span className="w-11 shrink-0 text-right text-sm tabular-nums">{scale}%</span>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 touch:h-11"
          disabled={scale === FONT_SCALE_DEFAULT}
          onClick={() => setFontScale(FONT_SCALE_DEFAULT)}
        >
          Reset
        </Button>
      </div>
    </SettingsRow>
  );
}
