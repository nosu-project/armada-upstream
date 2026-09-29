/**
 * Ids that loaded messages reply to but that aren't loaded themselves — the
 * parents a store read has to resolve. Sorted, so the list is a stable query key.
 */
export function missingReplyIds<M extends { id: string }>(
  messages: readonly M[],
  loaded: ReadonlyMap<string, unknown>,
  replyIdOf: (message: M) => string | undefined,
): string[] {
  const missing = new Set<string>();
  for (const m of messages) {
    const id = replyIdOf(m);
    if (id && !loaded.has(id)) missing.add(id);
  }
  return [...missing].sort();
}
