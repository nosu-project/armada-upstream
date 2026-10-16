/**
 * Natural sizes of images, and reported heights of self-sizing embeds, seen
 * this session, so a remount reserves the exact box instead of growing into it.
 * Keys come out of decrypted messages, so this is cleared on logout.
 */
const dims = new Map<string, string>();
const embedHeights = new Map<string, number>();
const MAX_DIMS = 1_000;

export function seenImageDim(url: string): string | undefined {
  return dims.get(url);
}

export function rememberImageDim(url: string, width: number, height: number): void {
  if (!width || !height || dims.has(url)) return;
  if (dims.size >= MAX_DIMS) dims.delete(dims.keys().next().value!);
  dims.set(url, `${width}x${height}`);
}

/** Last height an embed (`kind:id`, e.g. `tweet:123`) reported for itself. */
export function seenEmbedHeight(key: string): number | undefined {
  return embedHeights.get(key);
}

export function rememberEmbedHeight(key: string, height: number): void {
  if (!(height > 0)) return;
  embedHeights.delete(key);
  if (embedHeights.size >= MAX_DIMS) embedHeights.delete(embedHeights.keys().next().value!);
  embedHeights.set(key, height);
}

export function clearImageDims(): void {
  dims.clear();
  embedHeights.clear();
}
