import { Loader2, Search, X } from "lucide-react";
import { useState } from "react";

import { ChatContent } from "@/components/chat/ChatContent";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuthor } from "@/hooks/useAuthor";
import { useGroupSearch } from "@/hooks/useGroupSearch";
import { getAvatarShape } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";

import type { NostrEvent } from "@nostrify/nostrify";

function formatWhen(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function SearchResult({
  event,
  onPick,
}: {
  event: NostrEvent;
  onPick: (event: NostrEvent) => void;
}) {
  const author = useAuthor(event.pubkey);
  const metadata = author.data?.metadata;
  const name = getDisplayName(metadata, event.pubkey);

  return (
    <button
      type="button"
      onClick={() => onPick(event)}
      className="flex items-start gap-2.5 w-full px-2 py-2 rounded-lg text-left hover:bg-secondary/60 transition-colors"
    >
      <Avatar shape={getAvatarShape(metadata)} className="size-7 shrink-0 mt-0.5">
        <AvatarImage src={metadata?.picture} alt={name} />
        <AvatarFallback className="bg-primary/20 text-primary text-[10px]">
          {name[0]?.toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-primary truncate">{name}</span>
          <span className="text-[10px] text-muted-foreground/70 shrink-0">
            {formatWhen(event.created_at)}
          </span>
        </div>
        <ChatContent event={event} className="text-sm line-clamp-3" />
      </div>
    </button>
  );
}

/**
 * In-channel message search panel. Slides over the chat; queries the host
 * relay via NIP-50 (scoped to the group) and merges cached timeline matches.
 * Picking a result closes search and scrolls that message into view.
 */
export function GroupSearchPanel({
  relayUrl,
  groupId,
  onClose,
  onPick,
}: {
  relayUrl: string;
  groupId: string;
  onClose: () => void;
  onPick: (event: NostrEvent) => void;
}) {
  const [query, setQuery] = useState("");
  const { results, isLoading, active } = useGroupSearch(relayUrl, groupId, query);

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-background">
      <div className="flex items-center gap-2 p-3 border-b shrink-0">
        <Search className="size-4 text-muted-foreground shrink-0" />
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search this channel…"
          className="h-9"
        />
        <Button variant="ghost" size="icon" aria-label="Close search" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {!active ? (
          <p className="text-sm text-muted-foreground p-3">Type at least 2 characters to search.</p>
        ) : isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : results.length === 0 ? (
          <p className="text-sm text-muted-foreground p-3">No messages found.</p>
        ) : (
          results.map((event) => (
            <SearchResult
              key={event.id}
              event={event}
              onPick={(e) => {
                onPick(e);
                onClose();
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}
