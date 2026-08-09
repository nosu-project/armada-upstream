import { useSettingsDoc, type UseSettingsDocReturn } from "@/hooks/useSettingsDoc";
import { SETTINGS_KIND, settingsDTag } from "@/lib/settingsDocs";

/**
 * The user's private preferences: the `${APP_ID}/metadata` NIP-78 document.
 *
 * This used to be the ONE settings document, holding every synced field plus
 * the read state and the quick-reaction table. It is now the smallest of six —
 * see `lib/settingsDocs.ts` and `docs/settings-documents.md` — and holds only
 * bounded preferences. The other five are reached through
 * {@link useSettingsDoc} directly.
 *
 * Kept as a named hook because "the app's settings document" is a thing worth
 * naming, and because this is the document whose absence means "this user has
 * no Armada settings at all" — the condition every publisher checks before
 * writing anything (see the merge-over-`{}` rule on `useSettingsDoc`).
 */
export function useEncryptedSettings(): UseSettingsDocReturn<"metadata"> {
  return useSettingsDoc("metadata");
}

/** Kind and `d` tag of the metadata document. */
export { SETTINGS_KIND };
export const SETTINGS_D: string = settingsDTag("metadata");
