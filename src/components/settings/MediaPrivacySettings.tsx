import { Plus, RotateCcw, X } from "lucide-react";
import { useState } from "react";

import { SettingsRow } from "@/components/settings/SettingsSection";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/hooks/useAppContext";
import { toast } from "@/hooks/useToast";
import { DEFAULT_MEDIA_PROXY, fillUriTemplate, mediaHost, normalizeMediaProxy } from "@/lib/mediaPolicy";

/**
 * The media-privacy rows of the Media settings section: whether images load
 * through a proxy, and — when on — which proxies. Every image in a message is a
 * request from the viewer's device to the host the sender named; routing it
 * through a proxy (`lib/mediaPolicy.ts`) makes the proxy's address the one that
 * host sees. OFF by default; enabling it sets the public Ditto proxy, which the
 * user can replace or extend.
 *
 * The proxies are managed as a list, the same shape as the Blossom server list
 * (`AppConfig.mediaProxies`). The first is the primary the native background
 * writers and the one-image sites read (they do not rotate); with more than one,
 * the web client spreads each image across them and falls to the next when one
 * fails to load.
 */
export function MediaPrivacySettings() {
  const { config, updateConfig } = useAppContext();
  const proxies = config.mediaProxies;
  const enabled = proxies.length > 0;

  const setProxies = (next: string[]) => updateConfig((current) => ({ ...current, mediaProxies: next }));

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
        <Switch checked={enabled} onCheckedChange={(on) => setProxies(on ? [DEFAULT_MEDIA_PROXY] : [])} />
      </SettingsRow>
      {enabled && (
        <SettingsRow
          stack
          label="Proxy addresses"
          description={
            "Each proxy rewrites an image URL: use {href} where the target goes (percent-encoded), or "
            + "{+href} to pass it raw as some proxies (corsfix) expect; a bare address ending in ? or / "
            + "gets the URL appended automatically. Add more than one to spread images across them and "
            + "retry the next when a proxy fails."
          }
        >
          <MediaProxyListEditor
            proxies={proxies}
            onChange={setProxies}
            onReset={() => setProxies([DEFAULT_MEDIA_PROXY])}
          />
        </SettingsRow>
      )}
    </>
  );
}

/** Host of a proxy template, read off a filled probe (the `{href}` braces aren't URL chars). */
function proxyHost(proxy: string): string {
  const host = mediaHost(fillUriTemplate(proxy, { href: "https://example.com/x" }));
  return host ?? proxy.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/**
 * One proxy row: an avatar (letter fallback), host prominent, full template
 * underneath — the same shape as the Blossom `ServerIdentity`.
 */
function ProxyIdentity({ proxy }: { proxy: string }) {
  const host = proxyHost(proxy);
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <Avatar className="size-7 rounded-md shrink-0">
        <AvatarFallback className="rounded-md bg-secondary text-secondary-foreground text-xs">
          {host.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <div className="text-sm font-medium truncate leading-tight">{host}</div>
        <div className="text-xs text-muted-foreground font-mono truncate leading-tight">{proxy}</div>
      </div>
    </div>
  );
}

interface MediaProxyListEditorProps {
  proxies: string[];
  onChange: (proxies: string[]) => void;
  onReset?: () => void;
}

/** The proxy list: removable rows plus an inline add form, mirroring `BlossomServerListEditor`. */
function MediaProxyListEditor({ proxies, onChange, onReset }: MediaProxyListEditorProps) {
  const [draft, setDraft] = useState("");

  const handleAdd = () => {
    const normalized = normalizeMediaProxy(draft);
    if (!normalized) {
      toast({
        title: "Invalid proxy address",
        description: "Enter an https:// URL, with {href} where the image URL goes.",
        variant: "destructive",
      });
      return;
    }
    if (proxies.includes(normalized)) {
      toast({ title: "Already in the list", description: normalized });
      return;
    }
    onChange([...proxies, normalized]);
    setDraft("");
  };

  return (
    <div className="space-y-1.5">
      {proxies.map((proxy) => (
        <div key={proxy} className="flex items-center gap-2 rounded-md bg-background/40 px-3 py-2.5">
          <div className="flex-1 min-w-0">
            <ProxyIdentity proxy={proxy} />
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${proxy}`}
            className="size-7 text-muted-foreground hover:text-destructive shrink-0"
            onClick={() => onChange(proxies.filter((p) => p !== proxy))}
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
          placeholder={DEFAULT_MEDIA_PROXY}
          aria-label="Add proxy"
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-base md:text-sm bg-background/40 border-transparent"
        />
        <Button type="submit" disabled={!draft.trim()} className="clip-corner-lg shrink-0">
          <Plus className="size-4 mr-1.5" /> Add
        </Button>
      </form>

      {onReset && (
        <Button type="button" variant="ghost" size="sm" className="text-muted-foreground -ml-2" onClick={onReset}>
          <RotateCcw className="size-3.5 mr-1.5" /> Reset to default
        </Button>
      )}
    </div>
  );
}
