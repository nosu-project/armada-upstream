import { Loader2, Search, UserRoundCheck } from "lucide-react";
import { nip19 } from "nostr-tools";
import { useState } from "react";

import { BotPill } from "@/components/BotPill";
import { EmojifiedText } from "@/components/chat/CustomEmoji";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { useSearchProfiles, type SearchProfile } from "@/hooks/useSearchProfiles";
import { getAvatarShape } from "@/lib/avatarShape";
import { cn } from "@/lib/utils";

/**
 * A name/nip05 user picker built on the NIP-50 profile search (routed to the
 * search relays), with people you follow sorted first and badged. Mirrors
 * Ditto's left-sidebar account search, scoped down to a single-select picker
 * for flows like the Concord direct-invite. Inline (not a portal dropdown) so
 * it lives naturally inside a dialog.
 */
export function ProfileSearchSelect({
  onSelect,
  busyPubkey,
  placeholder = "Search people by name…",
  autoFocus,
}: {
  onSelect: (profile: SearchProfile) => void;
  /** When set, the matching row shows a spinner (e.g. an invite is sending). */
  busyPubkey?: string | null;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const { data: profiles, isFetching, followedPubkeys } = useSearchProfiles(query);

  const trimmed = query.trim();
  const results = trimmed.length >= 1 ? profiles ?? [] : [];

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          aria-label="Search people"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
          className="pl-9 pr-9"
        />
        {isFetching && (
          <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
      </div>

      {trimmed.length >= 1 && (
        <div className="max-h-60 overflow-y-auto rounded-lg bg-secondary/40 p-1">
          {results.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {isFetching ? "Searching…" : "No one found. Try a different name."}
            </div>
          ) : (
            results.map((profile) => (
              <ProfileRow
                key={profile.pubkey}
                profile={profile}
                isFollowed={followedPubkeys.has(profile.pubkey)}
                isBusy={busyPubkey === profile.pubkey}
                onClick={() => onSelect(profile)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ProfileRow({
  profile,
  isFollowed,
  isBusy,
  onClick,
}: {
  profile: SearchProfile;
  isFollowed: boolean;
  isBusy: boolean;
  onClick: () => void;
}) {
  const { metadata, pubkey } = profile;
  const displayName = metadata.name || metadata.display_name || "Anonymous";
  const identifier = metadata.nip05 || nip19.npubEncode(pubkey);

  return (
    <button
      type="button"
      disabled={isBusy}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors",
        "hover:bg-secondary/70 disabled:opacity-60",
      )}
    >
      <div className="relative shrink-0">
        <Avatar shape={getAvatarShape(metadata)} className="size-9">
          <AvatarImage src={metadata.picture} alt={displayName} />
          <AvatarFallback className="bg-primary/20 text-primary text-xs">
            {displayName[0]?.toUpperCase() || "?"}
          </AvatarFallback>
        </Avatar>
        {isFollowed && (
          <span
            title="Following"
            className="absolute -bottom-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-success text-success-foreground ring-2 ring-background"
          >
            <UserRoundCheck className="size-2.5" />
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="truncate text-sm font-semibold">
            <EmojifiedText tags={profile.event.tags}>{displayName}</EmojifiedText>
          </div>
          <BotPill metadata={metadata} />
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">{identifier}</div>
      </div>

      {isBusy && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
    </button>
  );
}
