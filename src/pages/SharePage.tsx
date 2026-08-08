import { useQueryClient } from "@tanstack/react-query";
import { File as FileIcon, Hash, Pin, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useAppContext } from "@/hooks/useAppContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDm17Conversations } from "@/hooks/useDm17";
import { useEventStore } from "@/hooks/useEventStore";
import { useNip29Servers } from "@/hooks/useNip29Servers";
import { usePinnedDms } from "@/hooks/usePinnedDms";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { useLiveCommunities } from "@/concord/hooks/useCommunityList";
import { flattenLayout, mergeLayout } from "@/lib/railLayout";
import { chatRoute } from "@/lib/routes";
import {
  assignShareRoute,
  discardShare,
  hasShareTarget,
  onShareStashChanged,
  pendingSharePreview,
  stashShare,
  type SharePayload,
} from "@/lib/shareTarget";
import {
  buildSwitcherEntries,
  switcherLiveKeys,
  type SwitcherContext,
  type SwitcherEntries,
} from "@/lib/switcher";

const EMPTY_ENTRIES: SwitcherEntries = { spaces: [], channels: [] };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One DM destination row: the peer's avatar + live display name. */
function DmDestination({
  peer,
  pinned,
  onSelect,
}: {
  peer: string;
  pinned: boolean;
  onSelect: () => void;
}) {
  const author = useAuthor(peer);
  const name = useScopedDisplayName(peer, author.data?.metadata);
  return (
    <CommandItem value={`${name} ${peer}`} onSelect={onSelect} className="touch:py-3">
      <Avatar className="mr-2 size-7 shrink-0">
        <AvatarImage src={author.data?.metadata?.picture} alt={name} />
        <AvatarFallback className="text-xs">{name.slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
      <span className="truncate">
        <DisplayName pubkey={peer} name={name} />
      </span>
      {pinned && <Pin className="ml-2 size-3.5 shrink-0 text-muted-foreground" />}
    </CommandItem>
  );
}

/**
 * The share destination picker: where content shared INTO Armada lands when
 * the user didn't already pick a conversation in the OS share sheet.
 *
 * Reached two ways: the Android share target ("Armada" tapped in the share
 * sheet — the payload is staged in the share stash by `shareTarget.ts`), and
 * the Web Share Target API of the installed PWA (payload in `title`/`text`/
 * `url` query params). Either way the user picks a DM or a channel; the
 * payload is routed to it through the share stash, and the ChatComposer
 * mounted there consumes it (text into the draft, files into the attachment
 * pipeline).
 *
 * Destinations are the same transport-agnostic, local-cache-only model the
 * quick switcher uses ({@link buildSwitcherEntries}), plus the user's DM
 * conversations — pinned first, then by recency, mirroring the DM list.
 */
export function SharePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  // Set when an in-app forward sent us here (the conversation it came from).
  // An OS share has no origin to return to, hence the "/" fallback.
  const forwardFrom = (useLocation().state as { forwardFrom?: string } | null)?.forwardFrom;
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const liveServers = useNip29Servers();
  const communities = useLiveCommunities();
  const { conversations } = useDm17Conversations({ interactive: true });
  const { pinned } = usePinnedDms();

  // The native payload (may land AFTER mount: a share's stream copies resolve
  // in the background while navigation runs — see shareTarget.ts).
  const [nativeShare, setNativeShare] = useState<SharePayload | null>(pendingSharePreview);
  useEffect(() => onShareStashChanged(() => setNativeShare(pendingSharePreview())), []);

  // Web Share Target params, merged into one text blob, skipping parts already
  // present in `text` (some apps put the URL in both).
  const rawText = params.get("text") ?? "";
  const title = params.get("title") ?? "";
  const url = params.get("url") ?? "";
  const webText = useMemo(() => {
    const parts: string[] = [];
    if (title && !rawText.includes(title)) parts.push(title);
    if (rawText) parts.push(rawText);
    if (url && !rawText.includes(url)) parts.push(url);
    return parts.join("\n");
  }, [title, rawText, url]);

  const payload = useMemo<SharePayload>(
    () => nativeShare ?? { text: webText, files: [] },
    [nativeShare, webText],
  );
  const hasContent = payload.text.length > 0 || payload.files.length > 0;

  // Channel destinations: the switcher's rail-ordered snapshot (see
  // QuickSwitcher for the identical construction).
  const orderedKeys = useMemo(() => {
    const liveKeys = switcherLiveKeys(liveServers, communities);
    const live = new Set(liveKeys);
    return flattenLayout(mergeLayout(config.railLayout, config.railOrder, liveKeys)).filter(
      (key) => live.has(key),
    );
  }, [liveServers, communities, config.railLayout, config.railOrder]);
  const ctx = useMemo<SwitcherContext>(
    () => ({
      queryClient,
      eventStore,
      communities: new Map(communities.map((c) => [c.community_id, c])),
      self: user?.pubkey,
    }),
    [queryClient, eventStore, communities, user?.pubkey],
  );
  const [entries, setEntries] = useState<SwitcherEntries>(EMPTY_ENTRIES);
  useEffect(() => {
    let live = true;
    void buildSwitcherEntries(orderedKeys, ctx).then((e) => {
      if (live) setEntries(e);
    });
    return () => {
      live = false;
    };
  }, [orderedKeys, ctx]);

  // DM destinations: pinned conversations first (each block newest-first),
  // matching the DM list's own ordering.
  const dmPeers = useMemo(() => {
    const pinnedSet = new Set(pinned);
    const byRecency = conversations.map((c) => c.peer);
    const pinnedRanked = byRecency.filter((p) => pinnedSet.has(p));
    for (const p of pinned) if (!pinnedRanked.includes(p)) pinnedRanked.push(p);
    const rest = byRecency.filter((p) => !pinnedSet.has(p));
    return [...pinnedRanked, ...rest].map((peer) => ({ peer, pinned: pinnedSet.has(peer) }));
  }, [conversations, pinned]);

  const pick = (route: string) => {
    // Route the payload to the chosen conversation; its composer consumes it.
    if (nativeShare) assignShareRoute(route);
    else stashShare(payload, route);
    navigate(route, { replace: true });
  };

  const dismiss = () => {
    discardShare();
    navigate(forwardFrom ?? "/", { replace: true });
  };

  return (
    <main className="flex-1 min-w-0 overflow-y-auto safe-area-top safe-area-bottom">
      <div className="mx-auto flex min-h-full max-w-xl flex-col gap-4 px-4 py-6">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-semibold leading-tight">
            {forwardFrom ? "Forward to…" : "Share to…"}
          </h1>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 touch:size-11"
            aria-label="Dismiss"
            onClick={dismiss}
          >
            <X className="size-4" />
          </Button>
        </div>

        {/* What's being shared */}
        <div className="bg-chrome clip-corner-lg p-3 space-y-2">
          {payload.text && (
            <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-sm text-foreground/90 leading-relaxed">
              {payload.text}
            </p>
          )}
          {payload.files.map((f, i) => (
            <div key={`${f.name}-${i}`} className="flex items-center gap-2 text-sm">
              <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{f.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{formatSize(f.size)}</span>
            </div>
          ))}
          {!hasContent && (
            <p className="text-sm italic text-muted-foreground">
              {hasShareTarget() ? "Preparing shared content…" : "Nothing shared"}
            </p>
          )}
        </div>

        {/* Destination picker */}
        <Command className="bg-chrome clip-corner-lg">
          <CommandInput placeholder="Search conversations…" autoFocus />
          <CommandList className="max-h-none">
            <CommandEmpty>No conversations found.</CommandEmpty>
            {user && dmPeers.length > 0 && (
              <CommandGroup heading="Direct messages">
                {dmPeers.map(({ peer, pinned: isPinned }) => (
                  <DmDestination
                    key={peer}
                    peer={peer}
                    pinned={isPinned}
                    onSelect={() => pick(chatRoute({ kind: "dm", peer }))}
                  />
                ))}
              </CommandGroup>
            )}
            {entries.channels.length > 0 && (
              <CommandGroup heading="Channels">
                {entries.channels.map((c) => (
                  <CommandItem
                    key={c.key}
                    value={`${c.name} ${c.spaceName} ${c.id}`}
                    onSelect={() => pick(c.route)}
                    className="touch:py-3"
                  >
                    <Hash className="mr-2 size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{c.name}</span>
                    <span className="ml-2 truncate text-xs text-muted-foreground">
                      {c.spaceName}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </div>
    </main>
  );
}

export default SharePage;
