import { Plus, X } from "lucide-react";
import { useState } from "react";

import { SettingsRow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppContext } from "@/hooks/useAppContext";
import { normalizeMutedWord } from "@/lib/mutedWords";

/** Edits `mutedWords`: messages containing any of them are hidden everywhere the block list applies. */
export function MutedWordsSettings() {
  const { config, updateConfig } = useAppContext();
  const words = config.mutedWords;
  const [draft, setDraft] = useState("");

  const handleAdd = () => {
    const word = normalizeMutedWord(draft);
    if (!word) return;
    updateConfig((current) => {
      const lower = word.toLowerCase();
      if (current.mutedWords.some((w) => w.toLowerCase() === lower)) return current;
      return { ...current, mutedWords: [...current.mutedWords, word] };
    });
    setDraft("");
  };

  const handleRemove = (word: string) => {
    updateConfig((current) => ({ ...current, mutedWords: current.mutedWords.filter((w) => w !== word) }));
  };

  return (
    <SettingsRow>
      <div className="space-y-1.5">
        <p className="pb-1 text-xs text-muted-foreground leading-snug">
          Hide messages that contain any of these words or phrases. Matching ignores case and only counts
          whole words. Your own messages are never hidden.
        </p>
        {words.map((word) => (
          <div key={word} className="flex items-center gap-2 clip-corner bg-background/40 px-3 py-2.5">
            <div className="flex-1 min-w-0 text-sm font-medium truncate leading-tight">{word}</div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Unmute ${word}`}
              className="size-7 text-muted-foreground hover:text-destructive shrink-0 touch:size-11"
              onClick={() => handleRemove(word)}
            >
              <X className="size-4" />
            </Button>
          </div>
        ))}

        <form
          className="flex gap-2 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            handleAdd();
          }}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Word or phrase"
            aria-label="Add muted word"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="text-base md:text-sm bg-background/40 border-transparent"
          />
          <Button type="submit" disabled={!normalizeMutedWord(draft)} className="clip-corner-lg shrink-0">
            <Plus className="size-4 mr-1.5" /> Add
          </Button>
        </form>
      </div>
    </SettingsRow>
  );
}
