import { useNostr } from "@nostrify/react";
import { FolderGit2, HelpCircle, Loader2, Search } from "lucide-react";
import { nip19 } from "nostr-tools";
import { useCallback, useMemo, useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { searchGitRepositories, useGitRepositoryDirectory } from "@/hooks/useGitRepositoryDirectory";
import type { GitRepositoryAnnouncement } from "@/lib/gitActivity";
import { resolveGitRepositoryAnnouncement } from "@/lib/gitRepositoryResolver";
import { cn } from "@/lib/utils";

/** A repository chosen from the picker, with the relays an attachment should carry. */
export interface PickedRepository {
  coordinate: string;
  relayHints: string[];
  displayName: string;
  identifier: string;
  owner: string;
}

/** The owner's profile name, or their truncated npub — never "Anonymous". */
function useOwnerName(pubkey: string): string {
  const author = useAuthor(pubkey);
  const named = author.data?.metadata?.name || author.data?.metadata?.display_name;
  if (named) return named;
  try {
    return nip19.npubEncode(pubkey).slice(0, 9);
  } catch {
    return pubkey.slice(0, 8);
  }
}

export function OwnerAvatar({ pubkey, className }: { pubkey: string; className?: string }) {
  const author = useAuthor(pubkey);
  const name = useOwnerName(pubkey);
  return (
    <Avatar className={cn("size-8 shrink-0 border border-border/60", className)}>
      <AvatarImage src={author.data?.metadata?.picture} alt={name} />
      <AvatarFallback className="text-[10px] font-semibold">{name.slice(0, 2).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

/** GitHub-style "owner / repo" title — same-named forks are otherwise indistinguishable. */
export function OwnerSlashRepo({ owner, name, className }: { owner: string; name: string; className?: string }) {
  const ownerName = useOwnerName(owner);
  return (
    <span className={cn("block truncate text-sm", className)}>
      <span className="text-muted-foreground">{ownerName}</span>
      <span className="text-muted-foreground/60"> / </span>
      <span className="font-semibold text-foreground">{name}</span>
    </span>
  );
}

function RepositoryRow({ repository, connected, onSelect }: { repository: GitRepositoryAnnouncement; connected: boolean; onSelect: () => void }) {
  const subtitle = connected ? "Already connected to this community" : repository.description;
  return (
    <button
      type="button"
      disabled={connected}
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
        connected ? "opacity-50" : "hover:bg-foreground/[0.05]",
      )}
    >
      <OwnerAvatar pubkey={repository.owner} />
      <span className="min-w-0 flex-1">
        <OwnerSlashRepo owner={repository.owner} name={repository.name} />
        {subtitle && <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>}
      </span>
    </button>
  );
}

/**
 * Find a NIP-34 repository: search the public ngit directory, or paste an
 * naddr / nostr:// address from a git client. Shared by the create-channel
 * wizard and the connect-repository flow so both read the same.
 */
export function RepositoryPicker({ connectedCoordinates, onSelect, autoFocus = true, className }: {
  connectedCoordinates: ReadonlySet<string>;
  onSelect: (repository: PickedRepository) => void;
  autoFocus?: boolean;
  className?: string;
}) {
  const { nostr } = useNostr();
  const [query, setQuery] = useState("");
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const directory = useGitRepositoryDirectory(true);
  const looksLikeAddress = /^(naddr1|nostr:)/i.test(query.trim());
  const results = useMemo(
    () => (looksLikeAddress ? [] : searchGitRepositories(directory.data ?? [], query, 8)),
    [directory.data, query, looksLikeAddress],
  );

  const choose = useCallback((repository: GitRepositoryAnnouncement) => {
    setError(null);
    onSelect({
      coordinate: repository.address.coordinate,
      relayHints: repository.relays,
      displayName: repository.name,
      identifier: repository.identifier,
      owner: repository.owner,
    });
  }, [onSelect]);

  const resolveAddress = useCallback(async () => {
    setError(null);
    setResolving(true);
    try {
      const resolved = await resolveGitRepositoryAnnouncement(nostr, query.trim());
      if (connectedCoordinates.has(resolved.address.coordinate)) {
        setError("This repository is already connected.");
        return;
      }
      onSelect({
        coordinate: resolved.address.coordinate,
        relayHints: resolved.relayHints,
        displayName: resolved.announcement.name,
        identifier: resolved.address.identifier,
        owner: resolved.address.owner,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't resolve that repository address.");
    } finally {
      setResolving(false);
    }
  }, [nostr, query, connectedCoordinates, onSelect]);

  return (
    <div className={cn("min-w-0 space-y-2.5", className)}>
      <div className="flex items-center gap-2 rounded-md border border-input px-2.5 focus-within:ring-1 focus-within:ring-ring">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          // Short enough to read in full inside a dialog-width field. What may
          // be pasted (an naddr, a nostr:// remote) is confirmed by the "Use
          // this repository address" row the moment one is detected, and spelled
          // out by whatever hosts the picker.
          placeholder="Search, or paste an address"
          autoFocus={autoFocus}
          disabled={resolving}
          // An input's intrinsic width comes from its `size`, so without this it
          // refuses to shrink below ~20 characters and overflows a narrow row.
          className="h-9 min-w-0 border-0 px-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
        />
        {/* The specifics the placeholder no longer has room to name. */}
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="What can I paste?"
                className="shrink-0 p-1 -mr-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                <HelpCircle className="size-4" />
              </button>
            </TooltipTrigger>
            {/* Above the dialog this usually sits in (z-[250]). */}
            <TooltipContent side="top" className="z-[260] max-w-60 text-center text-xs">
              Search the public ngit directory by name, or paste a repository
              address: an <span className="font-mono">naddr1…</span> or an{" "}
              <span className="font-mono">nostr://</span> remote from your git
              client.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="max-h-64 min-w-0 space-y-0.5 overflow-y-auto rounded-lg bg-secondary/40 p-1">
        {looksLikeAddress ? (
          <button
            type="button"
            disabled={resolving}
            onClick={() => void resolveAddress()}
            className="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-foreground/[0.05]"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40">
              {resolving ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : <FolderGit2 className="size-4 text-muted-foreground" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-foreground">{resolving ? "Resolving address…" : "Use this repository address"}</span>
              <span className="block truncate text-xs text-muted-foreground">{query.trim()}</span>
            </span>
          </button>
        ) : directory.isLoading ? (
          <p className="flex items-center gap-2 px-2.5 py-3 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Loading the public repository directory…
          </p>
        ) : results.length > 0 ? (
          <>
            {!query.trim() && <p className="px-2.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Recently announced</p>}
            {results.map((repository) => (
              <RepositoryRow
                key={repository.address.coordinate}
                repository={repository}
                connected={connectedCoordinates.has(repository.address.coordinate)}
                onSelect={() => choose(repository)}
              />
            ))}
          </>
        ) : (
          <p className="px-2.5 py-3 text-xs text-muted-foreground">
            {directory.isError
              ? "Couldn't reach the repository directory. You can still paste an naddr or nostr:// address."
              : "No repositories match. Try another name, or paste an naddr / nostr:// address."}
          </p>
        )}
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
