import { RotateCcw } from "lucide-react";
import { useState } from "react";

import { CurationSourceText } from "@/components/discover/CurationSource";
import { RelayListEditor } from "@/components/RelayListEditor";
import { SettingsRow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppContext } from "@/hooks/useAppContext";
import { useDiscoverCuration } from "@/hooks/useDiscover";
import { DISCOVER_CURATION_NONE, parseDiscoverCuration } from "@/lib/discoverSource";

/**
 * Where Discover's curated view comes from (`lib/discoverSource.ts`): the list
 * whose members seed the author allow-list, and the relays it reads. Both
 * default to this build's configuration and are overridable here. Choosing a
 * source only changes what this client READS — nothing is published.
 */
export function DiscoverSourceSettings() {
  const { config, updateConfig } = useAppContext();
  const curation = useDiscoverCuration();
  const overridden = config.discoverCuration.trim() !== "";
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const setCuration = (value: string) => {
    updateConfig((current) => ({ ...current, discoverCuration: value }));
  };
  const setRelays = (relays: string[]) => {
    updateConfig((current) => ({ ...current, discoverRelays: relays }));
  };

  const save = () => {
    const parsed = parseDiscoverCuration(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    // Stored as typed (trimmed) so the field reads back the way it was
    // entered; `resolveDiscoverCuration` re-parses it on every read.
    setCuration(draft.trim());
    setDraft("");
    setError(null);
  };

  return (
    <>
      <SettingsRow
        stack
        label="Curated list"
        description={
          <>
            Currently: <CurationSourceText curation={curation} />
            {overridden ? "." : " (default)."}
          </>
        }
      >
        <div className="space-y-1.5 sm:w-72">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <Input
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
              placeholder={`naddr1…, npub1…, or ${DISCOVER_CURATION_NONE}`}
              aria-label="Curated list source"
              aria-invalid={error ? true : undefined}
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-base md:text-sm bg-background/40 border-transparent"
            />
            <Button type="submit" disabled={!draft.trim()} className="clip-corner-lg shrink-0">
              Use
            </Button>
          </form>
          {error && <p className="text-xs text-destructive">{error}</p>}
          {overridden && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground -ml-2"
              onClick={() => setCuration("")}
            >
              <RotateCcw className="size-3.5 mr-1.5" /> Reset to default
            </Button>
          )}
        </div>
      </SettingsRow>
      <SettingsRow
        stack
        label="Discover relays"
        description="Where Discover loads from."
      >
        <RelayListEditor
          relays={config.discoverRelays}
          onChange={setRelays}
          onReset={config.discoverRelays.length > 0 ? () => setRelays([]) : undefined}
          emptyText="Using your app relays."
        />
      </SettingsRow>
    </>
  );
}
