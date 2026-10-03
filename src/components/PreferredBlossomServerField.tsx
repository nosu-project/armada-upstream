import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { normalizeBlossomServerUrl, PREFERRED_BLOSSOM_SERVER } from "@/lib/blossom";

export interface PreferredBlossomServerFieldProps {
  /** The stored preference; empty = none. */
  value: string;
  onChange: (server: string) => void;
}

/**
 * The Blossom server whose URL uploads embed. Committed on blur or Enter,
 * normalized; an address that doesn't parse is kept in the box, unsaved.
 */
export function PreferredBlossomServerField({ value, onChange }: PreferredBlossomServerFieldProps) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const invalid = draft.trim() !== "" && !normalizeBlossomServerUrl(draft);

  const commit = () => {
    if (!draft.trim()) {
      onChange("");
      return;
    }
    const normalized = normalizeBlossomServerUrl(draft);
    if (!normalized) return;
    setDraft(normalized);
    onChange(normalized);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          placeholder="https://blossom.example.com"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          aria-invalid={invalid}
        />
        {value !== PREFERRED_BLOSSOM_SERVER && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onChange(PREFERRED_BLOSSOM_SERVER)}
            aria-label="Reset preferred media server"
            title="Reset to default"
          >
            <RotateCcw className="size-4" />
          </Button>
        )}
      </div>
      {invalid && (
        <p className="text-xs text-destructive">
          Not a usable server address — enter one like https://blossom.example.com.
        </p>
      )}
    </div>
  );
}
