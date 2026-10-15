/** "v1.2.3 (date)", with a `+` on builds made between release tags. */
export function appVersionLabel(): string {
  const date = new Date(import.meta.env.BUILD_DATE).toLocaleDateString();
  return `v${import.meta.env.VERSION}${import.meta.env.COMMIT_TAG ? "" : "+"} (${date})`;
}
