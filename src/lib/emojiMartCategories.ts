import { Data } from "emoji-mart";

/** A custom (NIP-30 pack) category handed to emoji-mart's `custom` option. */
export interface EmojiMartCustomCategory {
  id: string;
  name: string;
  emojis: { id: string; name: string; keywords: string[]; skins: { src: string }[] }[];
}

/**
 * Reconcile emoji-mart's module-global `Data.originalCategories` with the
 * custom categories for a new Picker: emoji-mart only fills it on the FIRST
 * init, so packs added mid-session would get no section. Guarded in case a
 * future emoji-mart drops the field.
 */
export function syncEmojiMartCategories(categories: EmojiMartCustomCategory[]): void {
  const data = Data as { originalCategories?: unknown } | undefined;
  if (!data || !Array.isArray(data.originalCategories)) return;

  const ids = new Set(categories.map((c) => c.id));
  const kept = (data.originalCategories as { id: string }[]).filter((c) => !ids.has(c.id));
  data.originalCategories = [...kept, ...categories];
}
