import { useSettingsDoc, type UseSettingsDocReturn } from "@/hooks/useSettingsDoc";
import { SETTINGS_KIND } from "@/lib/settingsDocs";

/**
 * The `${APP_ID}/metadata` NIP-78 document: bounded private preferences, one of six
 * settings docs (see `lib/settingsDocs.ts`). Its absence means "no Armada settings at all",
 * which every publisher checks (see `useSettingsDoc`).
 */
export function useEncryptedSettings(): UseSettingsDocReturn<"metadata"> {
  return useSettingsDoc("metadata");
}

/** Kind and `d` tag of the metadata document. */
export { SETTINGS_KIND };
