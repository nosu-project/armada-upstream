import { ArrowLeft, ChevronDown, FolderGit2, Hash, Loader2, Lock, MessageSquareText } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { OwnerAvatar, OwnerSlashRepo, RepositoryPicker, type PickedRepository } from "@/components/projects/RepositoryPicker";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChromeDialogContent, Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/useToast";
import { cn } from "@/lib/utils";

import type { ChannelView } from "@/concord/lib/types";

/** What a new channel opens to (CORD-03 §2 `view`); changeable later. */
const VIEW_OPTIONS: ReadonlyArray<{ view: ChannelView; label: string; icon: typeof Hash }> = [
  { view: "chat", label: "Text", icon: Hash },
  { view: "forum", label: "Forum", icon: MessageSquareText },
];

export interface NewTextChannelOptions {
  isPrivate?: boolean;
  accessRoleName?: string;
  view?: ChannelView;
}

export type WizardRepository = PickedRepository;

/** No chooser: the dialog opens on `text`; repo is a detour. */
type Step = "text" | "repo" | "confirm";

function StepGlyph({ children }: { children: ReactNode }) {
  return (
    <div className="flex size-16 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
      {children}
    </div>
  );
}

/** Create a text/forum channel, or a repository channel tied to a NIP-34 repo. */
export function NewChannelDialog({ open, onOpenChange, connectedCoordinates, onCreateText, onCreateRepository }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectedCoordinates: ReadonlySet<string>;
  onCreateText: (name: string, opts?: NewTextChannelOptions) => Promise<unknown>;
  onCreateRepository: (name: string, repository: PickedRepository) => Promise<unknown>;
}) {
  const [step, setStep] = useState<Step>("text");
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<PickedRepository | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPrivate, setIsPrivate] = useState(true);
  const [view, setView] = useState<ChannelView>("chat");
  const [accessOpen, setAccessOpen] = useState(false);
  // Display only; the binding is the role's scope (CORD-04 §2).
  const [roleName, setRoleName] = useState("");

  useEffect(() => {
    if (!open) return;
    setStep("text");
    setName("");
    setSelected(null);
    setCreating(false);
    setError(null);
    setIsPrivate(true);
    setView("chat");
    setAccessOpen(false);
    setRoleName("");
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
        // `chat` rides as an ABSENT field.
        const opts: NewTextChannelOptions = {
          ...(isPrivate ? { isPrivate: true, accessRoleName: roleName.trim() || undefined } : {}),
          ...(view === "forum" ? { view } : {}),
        };
        await onCreateText(channelName, Object.keys(opts).length > 0 ? opts : undefined);
        // A newborn private channel's access role has no holders; point at granting it.
        const noun = view === "forum" ? "Forum" : "Channel";
        toast(
          isPrivate
            ? {
                title: `Private ${noun.toLowerCase()} created`,
                description: `Only you can read #${channelName} so far. Use Add members in the channel menu to let others in.`,
              }
            : { title: `${noun} created`, description: `#${channelName}` },
        );
      }
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the channel.");
    } finally {
      setCreating(false);
    }
  }, [name, creating, step, selected, isPrivate, view, roleName, onCreateRepository, onCreateText, onOpenChange]);

  const back = step === "repo"
    ? () => setStep("text")
    : step === "confirm"
      ? () => setStep("repo")
      : undefined;

  return (
    <Dialog open={open} onOpenChange={(next) => !creating && onOpenChange(next)}>
      <ChromeDialogContent title="Create a channel">
        {back && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute left-2 top-2 size-9 touch:size-11 text-muted-foreground hover:text-foreground"
            aria-label="Back"
            disabled={creating}
            onClick={back}
          >
            <ArrowLeft className="size-5" />
          </Button>
        )}

        {/* min-w-0 stops unbreakable strings from widening the grid dialog. */}
        <div className="flex min-w-0 flex-col items-center gap-5 text-center">
          <StepGlyph>
            {step === "text" ? <Hash className="size-7" /> : <FolderGit2 className="size-7" />}
          </StepGlyph>

          <div className="space-y-1.5">
            <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
              {step === "text" ? "new channel" : step === "repo" ? "choose a repository" : "name the channel"}
            </h2>
            <p className="text-sm text-muted-foreground">
              {step === "text"
                ? view === "forum"
                  ? "Titled posts with comments. Discussions that stay findable."
                  : "A live conversation for your community."
                : step === "repo"
                  ? "Search the public directory, or paste an address from your git client."
                  : "Its activity appears in the channel and in Projects."}
            </p>
          </div>

          {step === "text" && (
            <form
              className="w-full min-w-0 space-y-3 text-left"
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. general, memes, dev-talk"
                aria-label="Channel name"
                autoFocus
                disabled={creating}
                className="h-12 text-base"
              />

              <div className="flex rounded-md bg-secondary/50 p-0.5" role="radiogroup" aria-label="Channel type">
                {VIEW_OPTIONS.map((option) => {
                  const selectedView = option.view === view;
                  const Icon = option.icon;
                  return (
                    <button
                      key={option.view}
                      type="button"
                      role="radio"
                      aria-checked={selectedView}
                      disabled={creating}
                      onClick={() => setView(option.view)}
                      className={cn(
                        "flex flex-1 items-center justify-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors touch:py-2.5",
                        selectedView ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Icon className="size-3.5" />
                      {option.label}
                    </button>
                  );
                })}
              </div>

              <Collapsible open={accessOpen} onOpenChange={setAccessOpen} className="rounded-lg bg-secondary/50">
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    disabled={creating}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-sm touch:py-3"
                  >
                    {isPrivate ? <Lock className="size-3.5 text-muted-foreground" /> : <Hash className="size-3.5 text-muted-foreground" />}
                    <span className="font-medium">Access</span>
                    <span className="ml-auto text-xs text-muted-foreground">{isPrivate ? "Private" : "Public"}</span>
                    <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", accessOpen && "rotate-180")} />
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-3 px-3 pb-3">
                  <label htmlFor="channel2-private" className="flex cursor-pointer items-start gap-3">
                    <Checkbox
                      id="channel2-private"
                      checked={isPrivate}
                      onCheckedChange={(c) => setIsPrivate(c === true)}
                      disabled={creating}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">Private channel</span>
                      <span className="block text-xs text-muted-foreground">
                        Its own key, and a role that decides who can read it.
                      </span>
                    </span>
                  </label>
                  {isPrivate && (
                    <div className="space-y-1">
                      <Input
                        value={roleName}
                        onChange={(event) => setRoleName(event.target.value)}
                        placeholder={name.trim() ? `Role name (default: ${name.trim()})` : "Role name (default: channel name)"}
                        aria-label="Access role name"
                        disabled={creating}
                        maxLength={64}
                      />
                      <p className="text-xs text-muted-foreground">
                        Holders of this role can read the channel. More roles can be added later.
                      </p>
                    </div>
                  )}
                </CollapsibleContent>
              </Collapsible>

              {error && <p className="text-xs text-destructive">{error}</p>}

              <Button
                type="submit"
                size="lg"
                disabled={creating || !name.trim()}
                className="h-12 w-full clip-corner-lg text-base font-medium"
              >
                {creating ? <Loader2 className="size-4 animate-spin" /> : "Create channel"}
              </Button>

              <div className="flex items-center gap-3 pt-1">
                <span className="h-px flex-1 bg-border" />
                <span className="text-2xs uppercase tracking-wider text-muted-foreground">or</span>
                <span className="h-px flex-1 bg-border" />
              </div>
              <Button
                type="button"
                variant="ghost"
                disabled={creating}
                onClick={() => setStep("repo")}
                className="w-full text-muted-foreground hover:text-foreground"
              >
                <FolderGit2 className="size-4" />
                Connect a git repository
              </Button>
            </form>
          )}

          {step === "repo" && (
            <div className="w-full min-w-0 text-left">
              <RepositoryPicker connectedCoordinates={connectedCoordinates} onSelect={choose} />
            </div>
          )}

          {step === "confirm" && selected && (
            <form
              className="w-full min-w-0 space-y-3 text-left"
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <div className="flex min-w-0 items-center gap-2.5 rounded-lg bg-secondary/50 p-3">
                <OwnerAvatar pubkey={selected.owner} />
                <span className="min-w-0 flex-1">
                  <OwnerSlashRepo owner={selected.owner} name={selected.displayName} />
                </span>
              </div>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Channel name"
                aria-label="Channel name"
                autoFocus
                disabled={creating}
                className="h-12 text-base"
              />
              {error && <p className="text-xs text-destructive">{error}</p>}
              <Button
                type="submit"
                size="lg"
                disabled={creating || !name.trim()}
                className="h-12 w-full clip-corner-lg text-base font-medium"
              >
                {creating ? <Loader2 className="size-4 animate-spin" /> : "Create repository channel"}
              </Button>
            </form>
          )}
        </div>
      </ChromeDialogContent>
    </Dialog>
  );
}
