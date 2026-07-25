import { ArrowLeft, FolderGit2, Hash, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { OwnerAvatar, OwnerSlashRepo, RepositoryPicker, type PickedRepository } from "@/components/projects/RepositoryPicker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/useToast";

/** Re-exported under its original name for the page's handler signature. */
export type WizardRepository = PickedRepository;

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
      className="group flex w-full items-center gap-3 clip-corner-lg bg-card p-3.5 text-left transition-colors hover:bg-foreground/[0.03]"
    >
      <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted/40">
        <Icon className="size-5 text-muted-foreground transition-colors group-hover:text-foreground" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        <span className="block text-xs leading-4 text-muted-foreground">{description}</span>
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
  onCreateRepository: (name: string, repository: PickedRepository) => Promise<unknown>;
}) {
  const [step, setStep] = useState<Step>("type");
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<PickedRepository | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh wizard every time it opens.
  useEffect(() => {
    if (!open) return;
    setStep("type");
    setName("");
    setSelected(null);
    setCreating(false);
    setError(null);
  }, [open]);

  const choose = useCallback((repository: PickedRepository) => {
    setSelected(repository);
    setName(repository.identifier.toLowerCase());
    setError(null);
    setStep("confirm");
  }, []);

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

        {/* DialogContent is a grid; min-w-0 stops an unbreakable string (a
            hex identifier, a long URL) from widening the whole dialog. */}
        {step === "type" && (
          <div className="min-w-0 space-y-2.5">
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
            className="min-w-0 space-y-3"
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
          <RepositoryPicker connectedCoordinates={connectedCoordinates} onSelect={choose} />
        )}

        {step === "confirm" && selected && (
          <form
            className="min-w-0 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <div className="flex min-w-0 items-center gap-2.5 clip-corner-lg border border-border/60 bg-card p-2.5">
              <OwnerAvatar pubkey={selected.owner} />
              <span className="min-w-0 flex-1">
                <OwnerSlashRepo owner={selected.owner} name={selected.displayName} />
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
