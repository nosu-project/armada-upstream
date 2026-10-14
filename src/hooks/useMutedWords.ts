import { useContext, useMemo, useSyncExternalStore } from "react";

import { AppContext } from "@/contexts/AppContext";
import { getActivePubkey, subscribeActivePubkey } from "@/lib/activeAccount";
import { compileMutedWords } from "@/lib/mutedWords";

const NO_WORDS: string[] = [];

/** Whether a message trips the user's muted words; `null` when none are set. Own messages never do. */
export function useMutedWordFilter(): ((message: { pubkey: string; content: string }) => boolean) | null {
  // Context and account-marker reads, so timelines still render without the app's providers.
  const words = useContext(AppContext)?.config.mutedWords ?? NO_WORDS;
  const self = useSyncExternalStore(subscribeActivePubkey, getActivePubkey);
  return useMemo(() => {
    const matches = compileMutedWords(words);
    if (!matches) return null;
    return (message) => message.pubkey !== self && matches(message.content);
  }, [words, self]);
}
