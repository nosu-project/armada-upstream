import { Plus, RotateCcw, X } from "lucide-react";
import { useState } from "react";

import { SettingsRow } from "@/components/settings/SettingsSection";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/hooks/useAppContext";
import { toast } from "@/hooks/useToast";
import { KNOWN_MEDIA_HOSTS, normalizeMediaHostInput } from "@/lib/knownMediaHosts";
import { DEFAULT_MEDIA_PROXY, fillUriTemplate, mediaHost, normalizeMediaProxy } from "@/lib/mediaPolicy";

import type { MediaAutoload } from "@/concord/lib/mediaTrust";

const AUTOLOAD_DESCRIPTIONS: Record<MediaAutoload, string> = {
  trusted:
    "Images, videos and link previews from members who are new to you wait for you to tap "
    + "Load, and nothing is fetched until you do. Everyone else loads: moderators, people you "
    + "follow or talk with, members who were already here when you arrived, and members "
    + "you've seen here for a day.",
  always: "Every image, video and link preview loads as soon as it's on screen, whoever posted it.",
  never: "Nothing loads until you tap Load.",
};

/**
 * What loads without asking: the community media hold (`concord/lib/mediaTrust.ts`) by
 * sender and by host, and the media proxy (`lib/mediaPolicy.ts`, OFF by default). The
 * first proxy is primary for native writers and single-image sites; the web client
 * spreads across all and falls through on failure.
 */
export function MediaPrivacySettings() {
  const { config, updateConfig } = useAppContext();
  const proxies = config.mediaProxies;
  const enabled = proxies.length > 0;

  const setProxies = (next: string[]) => updateConfig((current) => ({ ...current, mediaProxies: next }));
  const setTrustedHosts = (next: string[]) => updateConfig((current) => ({ ...current, trustedMediaHosts: next }));

  return (
    <>
      <SettingsRow
        stack
        label="Load community media from"
        description={AUTOLOAD_DESCRIPTIONS[config.communityMediaAutoload]}
      >
        <Select
          value={config.communityMediaAutoload}
          onValueChange={(v) => updateConfig((current) => ({ ...current, communityMediaAutoload: v as MediaAutoload }))}
        >
          <SelectTrigger className="w-44 shrink-0" aria-label="Load community media from">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="trusted">People you trust</SelectItem>
            <SelectItem value="always">Everyone</SelectItem>
            <SelectItem value="never">Nobody</SelectItem>
          </SelectContent>
        </Select>
      </SettingsRow>
      <SettingsRow
        label="Ask before loading from other sites"
        description={
          enabled
            ? "Not needed while images load through a proxy: the sites see the proxy, not you."
            : "Media posted from a site other than your media servers, the sites below or the "
              + "common Nostr hosts waits for Load, whoever posted it. Loading it tells that site "
              + "your address."
        }
      >
        <Switch
          checked={config.communityMediaKnownHostsOnly}
          onCheckedChange={(on) => updateConfig((current) => ({ ...current, communityMediaKnownHostsOnly: on }))}
        />
      </SettingsRow>
      {config.communityMediaKnownHostsOnly && !enabled && (
        <SettingsRow
          stack
          label="Sites you trust"
          description={`Media from these loads without asking. Always included: your media servers and ${KNOWN_MEDIA_HOSTS.join(", ")}.`}
        >
          <TrustedHostListEditor hosts={config.trustedMediaHosts} onChange={setTrustedHosts} />
        </SettingsRow>
      )}
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

function HostIdentity({ host }: { host: string }) {
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <Avatar className="size-7 rounded-md shrink-0">
        <AvatarFallback className="rounded-md bg-secondary text-secondary-foreground text-xs">
          {host.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="text-sm font-medium truncate leading-tight">{host}</div>
    </div>
  );
}

function TrustedHostListEditor({ hosts, onChange }: { hosts: string[]; onChange: (hosts: string[]) => void }) {
  const [draft, setDraft] = useState("");

  const handleAdd = () => {
    const host = normalizeMediaHostInput(draft);
    if (!host) {
      toast({ title: "Invalid site", description: "Enter a site name like example.com.", variant: "destructive" });
      return;
    }
    if (!hosts.includes(host)) onChange([...hosts, host]);
    setDraft("");
  };

  return (
    <div className="space-y-1.5">
      {hosts.map((host) => (
        <div key={host} className="flex items-center gap-2 clip-corner bg-background/40 px-3 py-2.5">
          <div className="flex-1 min-w-0">
            <HostIdentity host={host} />
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${host}`}
            className="size-7 text-muted-foreground hover:text-destructive shrink-0 touch:size-11"
            onClick={() => onChange(hosts.filter((h) => h !== host))}
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
          placeholder="example.com"
          aria-label="Add site"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          className="text-base md:text-sm bg-background/40 border-transparent"
        />
        <Button type="submit" disabled={!draft.trim()} className="clip-corner-lg shrink-0">
          <Plus className="size-4 mr-1.5" /> Add
        </Button>
      </form>
    </div>
  );
}

/** Read off a filled probe: the `{href}` braces aren't URL chars. */
function proxyHost(proxy: string): string {
  const host = mediaHost(fillUriTemplate(proxy, { href: "https://example.com/x" }));
  return host ?? proxy.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

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
        <div key={proxy} className="flex items-center gap-2 clip-corner bg-background/40 px-3 py-2.5">
          <div className="flex-1 min-w-0">
            <ProxyIdentity proxy={proxy} />
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${proxy}`}
            className="size-7 touch:size-11 text-muted-foreground hover:text-destructive shrink-0"
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
