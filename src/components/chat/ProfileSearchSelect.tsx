import { Loader2, Search, UserRoundCheck } from "lucide-react";
import { nip19 } from "nostr-tools";
import { useState } from "react";

import { BotPill } from "@/components/BotPill";
import { EmojifiedText } from "@/components/chat/CustomEmoji";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useAuthor } from "@/hooks/useAuthor";
import { useSearchProfiles, type SearchProfile } from "@/hooks/useSearchProfiles";
import { getAvatarShape } from "@/lib/avatarShape";
import { resolvePubkey } from "@/lib/resolvePubkey";
import { cn } from "@/lib/utils";
import { parseProfileImeta } from "@/lib/profileImeta";

/**
 * Single-select user picker on NIP-50 profile search (follows first). Inline,
 * not a portal dropdown, so it sits naturally inside a dialog.
 */
export function ProfileSearchSelect({
  onSelect,
  busyPubkey,
  placeholder = "Search a name or paste an npub…",
  autoFocus,
}: {
  onSelect: (profile: SearchProfile) => void;
  busyPubkey?: string | null;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const { data: profiles, isFetching, followedPubkeys } = useSearchProfiles(query);

  const trimmed = query.trim();
  // A pasted npub/nprofile/hex names the person directly (text search can't).
  const pastedPubkey = resolvePubkey(trimmed);
  const results = trimmed.length >= 1 ? profiles ?? [] : [];

  // Clearing the query closes the popover (open is derived from `trimmed`).
  const handleChoose = (profile: SearchProfile) => {
    setQuery("");
    onSelect(profile);
  };

  return (
    // Portaled so the dialog keeps its height. Outside clicks are ignored so
    // clicking back into the input doesn't wipe the search.
    <Popover open={trimmed.length >= 1} onOpenChange={(o) => { if (!o) setQuery(""); }}>
      <PopoverAnchor asChild>
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
      </PopoverAnchor>

      <PopoverContent
        align="start"
        sideOffset={6}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        // Clamped to Radix's measured space: the dialog would clip rows past its edge.
        className="w-[var(--radix-popover-trigger-width)] max-h-[min(15rem,var(--radix-popover-content-available-height))] overflow-y-auto p-1"
      >
        {pastedPubkey ? (
          <PastedPubkeyRow
            pubkey={pastedPubkey}
            isFollowed={followedPubkeys.has(pastedPubkey)}
            isBusy={busyPubkey === pastedPubkey}
            onSelect={handleChoose}
          />
        ) : results.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {isFetching ? "Searching…" : "No one found. Try a different name, or paste an npub."}
          </div>
        ) : (
          results.map((profile) => (
            <ProfileRow
              key={profile.pubkey}
              profile={profile}
              isFollowed={followedPubkeys.has(profile.pubkey)}
              isBusy={busyPubkey === profile.pubkey}
              onClick={() => handleChoose(profile)}
            />
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Row for an exact pasted key; a pubkey without a kind-0 still gets a stub row. */
function PastedPubkeyRow({
  pubkey,
  isFollowed,
  isBusy,
  onSelect,
}: {
  pubkey: string;
  isFollowed: boolean;
  isBusy: boolean;
  onSelect: (profile: SearchProfile) => void;
}) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata ?? {};
  const event = author.data?.event ?? { id: "", kind: 0, pubkey, content: "", created_at: 0, sig: "", tags: [] };
  return (
    <ProfileRow
      profile={{ pubkey, metadata, event }}
      isFollowed={isFollowed}
      isBusy={isBusy}
      onClick={() => onSelect({ pubkey, metadata, event })}
    />
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
          <AvatarImage src={metadata.picture} imeta={parseProfileImeta(profile.event.tags, metadata)?.picture} alt={displayName} />
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
        <div className="truncate font-mono text-2xs text-muted-foreground">{identifier}</div>
      </div>

      {isBusy && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
    </button>
  );
}
