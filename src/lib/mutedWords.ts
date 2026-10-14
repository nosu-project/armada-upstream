/** A muted word as stored: trimmed, inner whitespace collapsed, NFKC. Empty means "not a word". */
export function normalizeMutedWord(word: string): string {
  return word.normalize("NFKC").trim().replace(/\s+/g, " ");
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One matcher for a list of muted words, or `null` when there is nothing to
 * match. Case-insensitive and whole-word, so muting "ass" leaves "class" alone;
 * an edge that is not a letter or digit (`#tag`, an emoji) matches as written.
 */
export function compileMutedWords(words: readonly string[]): ((text: string) => boolean) | null {
  const alternatives = [...new Set(words.map(normalizeMutedWord).filter(Boolean))].map((word) => {
    const start = WORD_CHAR.test(word[0]) ? "(?<![\\p{L}\\p{N}_])" : "";
    const end = WORD_CHAR.test(word[word.length - 1]) ? "(?![\\p{L}\\p{N}_])" : "";
    return start + escapeRegExp(word).replace(/ /g, "\\s+") + end;
  });
  if (alternatives.length === 0) return null;
  const pattern = new RegExp(alternatives.join("|"), "iu");
  return (text) => pattern.test(text.normalize("NFKC"));
}
