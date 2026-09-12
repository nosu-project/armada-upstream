import { ArrowLeft, FolderGit2, Hash, Loader2, Lock, MessageSquareText } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { OwnerAvatar, OwnerSlashRepo, RepositoryPicker, type PickedRepository } from "@/components/projects/RepositoryPicker";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ChromeDialogContent, Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/useToast";
import { cn } from "@/lib/utils";

import type { ChannelView } from "@/concord/lib/types";

/**
 * What a new channel opens to (CORD-03 §2 `view`): one small segmented
 * control, icon and a word each. No blurbs — the forum's own empty state
 * explains itself the first time it is opened, and the choice can be flipped
 * later from the channel's settings.
 */
const VIEW_OPTIONS: ReadonlyArray<{ view: ChannelView; label: string; icon: typeof Hash }> = [
  { view: "chat", label: "Text", icon: Hash },
  { view: "forum", label: "Forum", icon: MessageSquareText },
];

/** The create-text options the page's handler takes. */
export interface NewTextChannelOptions {
  isPrivate?: boolean;
  accessRoleName?: string;
  /** The presentation the channel opens to; `chat` when omitted. */
  view?: ChannelView;
}

/** Re-exported under its original name for the page's handler signature. */
export type WizardRepository = PickedRepository;

/**
 * A text channel is what "create a channel" means; the repository path is a
 * detour off it. There is no chooser step, so `text` is where the dialog opens.
 */
type Step = "text" | "repo" | "confirm";

/** The glyph frame the wizard steps use, sized down for a dialog. */
function StepGlyph({ children }: { children: ReactNode }) {
  return (
    <div className="flex size-16 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
      {children}
    </div>
  );
}

/**
 * Create a channel: a plain text channel, or a repository channel that ties a
 * NIP-34 repo to it — found by searching the public ngit directory or by pasting
 * an naddr / nostr:// address from a git client.
 *
 * Text is the default and the repository path is a secondary door at the bottom
 * of it, rather than the two being equal halves of a chooser screen: naming a
 * text channel is the overwhelmingly common case, and it used to cost a step of
 * its own before you could type anything.
 */
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
  // The access role's name, display only: the binding is the role's scope
  // (CORD-04 §2). Left empty it matches the channel, the common case.
  const [roleName, setRoleName] = useState("");

  // Fresh dialog every time it opens.
  useEffect(() => {
    if (!open) return;
    setStep("text");
    setName("");
    setSelected(null);
    setCreating(false);
    setError(null);
    setIsPrivate(true);
    setView("chat");
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
        // `chat` is the default and rides as an ABSENT field, so a plain
        // public text channel still creates with no options at all.
        const opts: NewTextChannelOptions = {
          ...(isPrivate ? { isPrivate: true, accessRoleName: roleName.trim() || undefined } : {}),
          ...(view === "forum" ? { view } : {}),
        };
        await onCreateText(channelName, Object.keys(opts).length > 0 ? opts : undefined);
        // A newborn private channel has an access role nobody holds yet, so
        // point at the door that grants it rather than leaving the creator in
        // a room that looks like it simply has no members.
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

  // The repository detour is the only thing there is to come back from.
  const back = step === "repo"
    ? () => setStep("text")
    : step === "confirm"
      ? () => setStep("repo")
      : undefined;

  return (
    <Dialog open={open} onOpenChange={(next) => !creating && onOpenChange(next)}>
      <ChromeDialogContent title="Create a channel">
        {/* Mirrors the close button's corner, as the wizard's header does. */}
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

        {/* The chrome card is a grid; min-w-0 stops an unbreakable string (a hex
            identifier, a long URL) from widening the whole dialog. */}
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

              {/* Text or forum: a segmented control, nothing to read. */}
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

              <label
                htmlFor="channel2-private"
                className="flex cursor-pointer items-start gap-3 rounded-lg bg-secondary/50 p-3"
              >
                <Checkbox
                  id="channel2-private"
                  checked={isPrivate}
                  onCheckedChange={(c) => setIsPrivate(c === true)}
                  disabled={creating}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <Lock className="size-3.5" /> Private channel
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Gets its own key, and a role that decides who can read it.
                    Enforced in every client.
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
                    Members holding this role can read the channel. More roles can
                    be added later from the channel's access settings.
                  </p>
                </div>
              )}

              {error && <p className="text-xs text-destructive">{error}</p>}

              <Button
                type="submit"
                size="lg"
                disabled={creating || !name.trim()}
                className="h-12 w-full clip-corner-lg text-base font-medium"
              >
                {creating ? <Loader2 className="size-4 animate-spin" /> : "Create channel"}
              </Button>

              {/* The secondary door. Below the primary action and quieter than
                  it, so the common case is never a choice you have to make. */}
              <div className="flex items-center gap-3 pt-1">
                <span className="h-px flex-1 bg-border" />
                <span className="text-[0.7rem] uppercase tracking-wider text-muted-foreground">or</span>
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
