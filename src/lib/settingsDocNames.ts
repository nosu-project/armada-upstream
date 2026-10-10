/**
 * The settings documents, by name. Kept free of imports so key derivation
 * (`settingsKeys.ts`) does not drag in the schemas and AppConfig.
 * Adding one needs: a name here, a schema in `schemas.ts`, a key list in
 * `AppContext.ts` if it mirrors AppConfig, and the Android service's default set.
 */
export const SETTINGS_DOC_NAMES = [
  "metadata",
  "rail",
  "read-state",
  "read-state-recent",
  "notifications",
  "dms",
  "reactions",
] as const;

export type SettingsDocName = (typeof SETTINGS_DOC_NAMES)[number];
