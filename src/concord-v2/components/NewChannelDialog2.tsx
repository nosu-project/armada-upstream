import { useNostr } from "@nostrify/react";
import { ArrowLeft, FolderGit2, Hash, Loader2, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/useToast";
import { searchGitRepositories, useGitRepositoryDirectory } from "@/hooks/useGitRepositoryDirectory";
import type { GitRepositoryAnnouncement } from "@/lib/gitActivity";
import { resolveGitRepositoryAnnouncement } from "@/lib/gitRepositoryResolver";
import { cn } from "@/lib/utils";

/** A repository chosen in the wizard, with the relays an attachment should carry. */
export interface WizardRepository {
  coordinate: string;
  relayHints: string[];
  displayName: string;
  identifier: string;
}

type Step = "type" | "text" | "repo" | "confirm";

function stepTitle(step: Step): string {
  switch (step) {
    case "type": return "Create a channel";
    case "text": return "New text channel";
    case "repo": return "Choose a repository";
    case "confirm": return "New repository channel";
  }
}

function TypeCard({ icon: Icon, title, description, onClick }: { icon: typeof Hash; title: string; description: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 clip-corner-lg border border-border/60 bg-card p-3.5 text-left transition-colors hover:border-primary/50 hover:bg-foreground/[0.03]"
    >
      <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40 transition-colors group-hover:border-primary/40">
        <Icon className="size-5 text-muted-foreground transition-colors group-hover:text-foreground" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        <span className="block text-xs leading-4 text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

function RepositoryRow({ repository, connected, onSelect }: { repository: GitRepositoryAnnouncement; connected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      disabled={connected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
        connected ? "opacity-50" : "hover:bg-foreground/[0.05]",
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40">
        <FolderGit2 className="size-4 text-muted-foreground" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{repository.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {connected ? "Already connected to this community" : repository.description || repository.identifier}
        </span>
      </span>
    </button>
  );
}

/**
 * The create-channel wizard: a plain text channel, or a repository channel
 * that ties a NIP-34 repo to the new channel — found by searching the public
 * ngit directory or by pasting an naddr / nostr:// address from a git client.
 */
export function NewChannelDialog2({ open, onOpenChange, connectedCoordinates, onCreateText, onCreateRepository }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectedCoordinates: ReadonlySet<string>;
  onCreateText: (name: string) => Promise<unknown>;
  onCreateRepository: (name: string, repository: WizardRepository) => Promise<unknown>;
}) {
  const { nostr } = useNostr();
  const [step, setStep] = useState<Step>("type");
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<WizardRepository | null>(null);
  const [resolving, setResolving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh wizard every time it opens.
  useEffect(() => {
    if (!open) return;
    setStep("type");
    setName("");
    setQuery("");
    setSelected(null);
    setResolving(false);
    setCreating(false);
    setError(null);
  }, [open]);

  const directory = useGitRepositoryDirectory(open && step === "repo");
  const looksLikeAddress = /^(naddr1|nostr:)/i.test(query.trim());
  const results = useMemo(
    () => (looksLikeAddress ? [] : searchGitRepositories(directory.data ?? [], query, 8)),
    [directory.data, query, looksLikeAddress],
  );

  const choose = useCallback((repository: GitRepositoryAnnouncement) => {
    setSelected({
      coordinate: repository.address.coordinate,
      relayHints: repository.relays,
      displayName: repository.name,
      identifier: repository.identifier,
    });
    setName(repository.identifier.toLowerCase());
    setError(null);
    setStep("confirm");
  }, []);

  const resolveAddress = useCallback(async () => {
    setError(null);
    setResolving(true);
    try {
      const resolved = await resolveGitRepositoryAnnouncement(nostr, query.trim());
      setSelected({
        coordinate: resolved.address.coordinate,
        relayHints: resolved.relayHints,
        displayName: resolved.announcement.name,
        identifier: resolved.address.identifier,
      });
      setName(resolved.address.identifier.toLowerCase());
      setStep("confirm");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't resolve that repository address.");
    } finally {
      setResolving(false);
    }
  }, [nostr, query]);

  const create = useCallback(async () => {
    const channelName = name.trim();
    if (!channelName || creating) return;
    setError(null);
    setCreating(true);
    try {
      if (step === "confirm" && selected) {
        await onCreateRepository(channelName, selected);
        toast({ title: "Repository channel created", description: `#${channelName} · ${selected.displayName}` });
      } else {
        await onCreateText(channelName);
        toast({ title: "Channel created", description: `#${channelName}` });
      }
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the channel.");
    } finally {
      setCreating(false);
    }
  }, [name, creating, step, selected, onCreateRepository, onCreateText, onOpenChange]);

  const back = step === "text" || step === "repo" ? () => setStep("type") : step === "confirm" ? () => setStep("repo") : undefined;

  return (
    <Dialog open={open} onOpenChange={(next) => !creating && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            {back && (
              <Button variant="ghost" size="icon" className="-ml-1.5 size-7" aria-label="Back" disabled={creating} onClick={back}>
                <ArrowLeft className="size-4" />
              </Button>
            )}
            {stepTitle(step)}
          </DialogTitle>
        </DialogHeader>

        {step === "type" && (
          <div className="space-y-2.5">
            <TypeCard
              icon={Hash}
              title="Text channel"
              description="A plain conversation space for your community."
              onClick={() => setStep("text")}
            />
            <TypeCard
              icon={FolderGit2}
              title="Repository channel"
              description="Ties a git repository to the channel: live activity in chat, and a Projects view for issues and PRs."
              onClick={() => setStep("repo")}
            />
          </div>
        )}

        {step === "text" && (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. general, memes, dev-talk"
              autoFocus
              disabled={creating}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={creating || !name.trim()}>
                {creating ? <Loader2 className="size-4 animate-spin" /> : "Create channel"}
              </Button>
            </div>
          </form>
        )}

        {step === "repo" && (
          <div className="space-y-2.5">
            <div className="flex items-center gap-2 rounded-md border border-input px-2.5 focus-within:ring-1 focus-within:ring-ring">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search repositories, or paste an naddr / nostr:// address"
                autoFocus
                disabled={resolving}
                className="h-9 border-0 px-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
              />
            </div>
            <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-lg bg-secondary/40 p-1">
              {looksLikeAddress ? (
                <button
                  type="button"
                  disabled={resolving}
                  onClick={() => void resolveAddress()}
                  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-foreground/[0.05]"
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
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}

        {step === "confirm" && selected && (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <div className="flex items-center gap-2.5 clip-corner-lg border border-border/60 bg-card p-2.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40">
                <FolderGit2 className="size-4 text-muted-foreground" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-foreground">{selected.displayName}</span>
                <span className="block truncate text-xs text-muted-foreground">Activity will appear in the channel and in Projects.</span>
              </span>
            </div>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Channel name"
              autoFocus
              disabled={creating}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={creating || !name.trim()}>
                {creating ? <Loader2 className="size-4 animate-spin" /> : "Create repository channel"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
