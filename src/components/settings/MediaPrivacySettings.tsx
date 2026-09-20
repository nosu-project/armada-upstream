import { RotateCcw } from "lucide-react";
import { useState } from "react";

import { SettingsRow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/hooks/useAppContext";
import { toast } from "@/hooks/useToast";
import { DEFAULT_MEDIA_PROXY, normalizeMediaProxy } from "@/lib/mediaPolicy";

/**
 * The media-privacy rows of the Media settings section: whether images load
 * through a proxy, and which one. Every image in a message is a request from
 * the viewer's device to the host the sender named; routing it through a proxy
 * (`lib/mediaPolicy.ts`) makes the proxy's address the one that host sees. On
 * by default, and the single `mediaProxy` string is the whole switch — empty
 * turns it off and media loads directly.
 */
export function MediaPrivacySettings() {
  const { config, updateConfig } = useAppContext();
  const enabled = normalizeMediaProxy(config.mediaProxy) !== "";

  const setEnabled = (on: boolean) =>
    updateConfig((current) => ({ ...current, mediaProxy: on ? DEFAULT_MEDIA_PROXY : "" }));

  return (
    <>
      <SettingsRow
        label="Load images through a proxy"
        description={
          "Every image in a message is a request from your device to whatever site the sender "
          + "named, which tells that site your address. With this on, images are fetched through a "
          + "proxy that sees the site instead of you. Turn it off to load images directly."
        }
      >
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </SettingsRow>
      {enabled && (
        <SettingsRow
          stack
          label="Proxy address"
          description="The proxy sees every image it fetches for you. Use {href} where the target URL goes."
        >
          <MediaProxyField />
        </SettingsRow>
      )}
    </>
  );
}

/** The proxy template input: saved on blur or Enter, with a reset to the default. */
function MediaProxyField() {
  const { config, updateConfig } = useAppContext();
  const [draft, setDraft] = useState(config.mediaProxy);
  const [editing, setEditing] = useState(false);
  const value = editing ? draft : config.mediaProxy;

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed === config.mediaProxy) return;
    const normalized = normalizeMediaProxy(trimmed);
    if (!normalized) {
      toast({
        title: "Invalid proxy address",
        description: "Enter an https:// URL, with {href} where the image URL goes.",
        variant: "destructive",
      });
      setDraft(config.mediaProxy);
      return;
    }
    updateConfig((current) => ({ ...current, mediaProxy: normalized }));
  };

  return (
    <div className="space-y-1.5">
      <Input
        value={value}
        onFocus={() => {
          setDraft(config.mediaProxy);
          setEditing(true);
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        placeholder={DEFAULT_MEDIA_PROXY}
        aria-label="Proxy address"
        autoComplete="off"
        spellCheck={false}
        className="font-mono text-base md:text-sm bg-background/40 border-transparent"
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          Default: <span className="font-mono break-all">{DEFAULT_MEDIA_PROXY}</span>
        </span>
        {config.mediaProxy !== DEFAULT_MEDIA_PROXY && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 -ml-2 text-muted-foreground"
            onClick={() => {
              setEditing(false);
              setDraft(DEFAULT_MEDIA_PROXY);
              updateConfig((current) => ({ ...current, mediaProxy: DEFAULT_MEDIA_PROXY }));
            }}
          >
            <RotateCcw className="size-3.5 mr-1.5" /> Reset to default
          </Button>
        )}
      </div>
    </div>
  );
}
