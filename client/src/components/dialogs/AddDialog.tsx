import { ChevronDown, ClipboardPaste, Link2, Loader2, Server, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppContext } from "@/hooks/useAppContext";
import { useConcordActions } from "@/hooks/useConcordActions";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { readClipboardText } from "@/lib/clipboard";
import { classifyAddInput, CORD_CREATE_ENABLED, type ConcordCommunity } from "@/lib/concord";
import { PLATFORM_RELAYS, relayToHttpUrl } from "@/lib/platform";
import { cn } from "@/lib/utils";

interface AddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The "Add" wizard, restructured around Concord.
 *
 * The headline act is **starting an end-to-end-encrypted chat** — name it, hit
 * a button, you own a serverless community. Everything else (joining an existing
 * community, or connecting to a trust-the-host NIP-29 relay) folds into a single
 * smaller "escape hatch": one smart-paste field that figures out what you gave
 * it — a Concord invite link, a bare domain-agnostic invite token, or a relay
 * URL — and does the right thing.
 *
 * Styled to match the rest of the deck: a cut-corner chrome card (same shape as
 * the member roster / composer), the animated crest up top, the same easy-brain
 * polish as the login and welcome screens.
 */
export function AddDialog({ open, onOpenChange }: AddDialogProps) {
  const close = () => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <ChromeDialogContent title="Add an encrypted chat or server">
        <AddBody onDone={close} />
        <ArmadaCrestKeyframes />
      </ChromeDialogContent>
    </Dialog>
  );
}

function AddBody({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const { createCommunity, isWorking: isCreating } = useConcordActions();

  const [name, setName] = useState("");
  const [experimental, setExperimental] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const finishConcord = (community: ConcordCommunity) => {
    onDone();
    toast({ title: "Encrypted chat ready", description: community.name });
    navigate(`/c/${encodeURIComponent(community.communityId)}`);
  };

  const handleCreate = async () => {
    setCreateError(null);
    try {
      // Defense in depth: the experimental flag can never leave a prod build
      // even if state were somehow set (the checkbox isn't rendered there).
      const community = await createCommunity({
        name: name.trim(),
        experimental: experimental && CORD_CREATE_ENABLED,
      });
      finishConcord(community);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Couldn't create the chat.");
    }
  };

  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <ArmadaCrest size={84} />

      <div className="space-y-1.5">
        <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
          start an encrypted chat
        </h2>
        <p className="text-sm text-muted-foreground">
          Serverless and end-to-end-encrypted. No host can read it; your key is
          your membership. You become the owner.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleCreate();
        }}
        className="w-full space-y-3"
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name your chat"
          aria-label="Chat name"
          autoComplete="off"
          autoFocus
          className="h-12 text-base"
        />

        {/* EXPLICIT OPT-IN for the experimental CORD wire format — dev builds
            only (production keeps the create flow strictly Vector-parity).
            Off by default so every ordinary community (and its invite links)
            stays byte-compatible with Concord/Vector. The choice is per
            community and permanent. */}
        {CORD_CREATE_ENABLED && (
          <label className="flex items-start gap-2.5 rounded-md bg-secondary/40 px-3 py-2.5 text-left cursor-pointer select-none">
            <input
              type="checkbox"
              checked={experimental}
              onChange={(e) => setExperimental(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-primary"
              aria-label="Use the experimental CORD protocol"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                Experimental protocol <span className="text-muted-foreground">(CORD)</span>
              </span>
              <span className="block text-xs text-muted-foreground">
                Next-gen wire format: stream-camouflaged traffic, spam-proof
                addressing, keyless public channels. Invites only open in CORD-aware
                clients — leave off for Vector compatibility.
              </span>
            </span>
          </label>
        )}

        {createError && (
          <Alert variant="destructive">
            <AlertDescription>{createError}</AlertDescription>
          </Alert>
        )}

        <Button
          type="submit"
          size="lg"
          disabled={isCreating || !name.trim()}
          className="h-12 w-full clip-corner-lg text-base font-medium"
        >
          {isCreating ? (
            <><Loader2 className="size-4 mr-2 animate-spin" /> Creating...</>
          ) : (
            <><ShieldCheck className="size-4 mr-2" /> Create encrypted chat</>
          )}
        </Button>
      </form>

      <EscapeHatch onDone={onDone} onConcordJoined={finishConcord} />
    </div>
  );
}

/**
 * The "I already have something" path, kept deliberately small and secondary.
 * One field, one classifier: a Concord invite link, a bare (domain-agnostic)
 * invite token, or a NIP-29 relay URL all go here.
 *
 * Look before you leap: as soon as the input classifies, we *resolve* it —
 * fetch the Concord invite's sealed bundle, or the relay's NIP-11 document —
 * and show where you're being invited to. The Join / Add button only appears
 * once that resolution succeeds, so you commit to something you can see.
 */
/** What a resolved (validated + loaded) target looks like, for the preview card. */
type Target =
  | { kind: "concord"; name: string; about?: string; channelCount: number; relays: string[] }
  | { kind: "nip29"; relay: string; name?: string; description?: string };

function EscapeHatch({
  onDone,
  onConcordJoined,
}: {
  onDone: () => void;
  onConcordJoined: (community: ConcordCommunity) => void;
}) {
  const { config, updateConfig } = useAppContext();
  const { user } = useCurrentUser();
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const { previewInvite, joinViaInvite, isWorking: isJoining } = useConcordActions();

  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [committing, setCommitting] = useState(false);

  const classified = useMemo(() => classifyAddInput(value), [value]);

  // A stable identity for the classified input, so the resolve effect only
  // re-runs when the *target* changes — not on every keystroke that resolves
  // to the same relay/invite token.
  const identity =
    classified.kind === "concord"
      ? `c:${classified.invite.token}`
      : classified.kind === "nip29"
        ? `n:${classified.relay}`
        : "";

  /** Read the clipboard into the field (web + native), surfacing failures. */
  const handlePaste = async () => {
    try {
      const text = (await readClipboardText()).trim();
      if (text) {
        setValue(text);
        setError(null);
      }
    } catch {
      toast({
        title: "Paste failed",
        description: "Couldn't read the clipboard. Paste manually instead.",
        variant: "destructive",
      });
    }
  };

  // Resolve (validate + load) the target whenever the classified input settles.
  // Debounced so paste/typing doesn't fire a fetch per character, and guarded so
  // a stale resolution can't overwrite a newer one.
  useEffect(() => {
    setTarget(null);
    setError(null);
    if (!identity) {
      setResolving(false);
      return;
    }

    let cancelled = false;
    setResolving(true);
    const timer = setTimeout(async () => {
      try {
        if (classified.kind === "concord") {
          const { community, channelCount } = await previewInvite({ invite: classified.invite });
          if (cancelled) return;
          setTarget({
            kind: "concord",
            name: community.name,
            about: community.about,
            channelCount,
            relays: community.relays,
          });
        } else if (classified.kind === "nip29") {
          const relay = classified.relay;
          if (PLATFORM_RELAYS.includes(relay) || config.addedRelays.includes(relay)) {
            throw new Error("That server is already in your list.");
          }
          const res = await fetch(relayToHttpUrl(relay), {
            headers: { Accept: "application/nostr+json" },
            signal: AbortSignal.timeout(8000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const info = (await res.json()) as { name?: string; description?: string };
          if (cancelled) return;
          setTarget({ kind: "nip29", relay, name: info.name, description: info.description });
        }
      } catch (e) {
        if (cancelled) return;
        setError(
          e instanceof Error
            ? e.message
            : classified.kind === "concord"
              ? "Couldn't load that invite."
              : "Could not reach that relay's NIP-11 endpoint. Check the URL and your network.",
        );
      } finally {
        if (!cancelled) setResolving(false);
      }
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `classified` is derived from `value`; `identity` captures the parts that
    // matter, so we key the effect on it (plus the lists that gate nip29 dupes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, config.addedRelays]);

  const handleCommit = async () => {
    if (!target) return;
    setError(null);
    setCommitting(true);
    try {
      if (target.kind === "concord") {
        if (classified.kind !== "concord") return;
        const community = await joinViaInvite({ invite: classified.invite });
        onConcordJoined(community);
        return;
      }
      // nip29: already validated in the preview; persist + sync.
      updateConfig((current) => ({
        ...current,
        addedRelays: [...current.addedRelays, target.relay],
      }));
      if (user) {
        updateList({ type: "add-server", url: target.relay }).catch((err) =>
          console.warn("Failed to sync server to group list:", err));
      }
      toast({ title: "Server added", description: target.name || target.relay });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setCommitting(false);
    }
  };

  const busy = isJoining || committing;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="mx-auto flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <Link2 className="size-3.5" />
          Have an invite or server URL?
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleCommit();
          }}
          className="mt-4 text-left"
        >
          <div className="flex gap-2">
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Paste invite or server URL"
              aria-label="Invite link, invite code, or server URL"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="min-w-0"
            />
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    aria-label="Paste from clipboard"
                    onClick={handlePaste}
                  >
                    <ClipboardPaste className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="z-[260] max-w-60 text-center text-xs">
                  Paste a Concord invite link, a bare invite code, or a server
                  relay URL. We detect which it is.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>

          {resolving && (
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {classified.kind === "concord" ? "Loading invite..." : "Reaching server..."}
            </div>
          )}

          {error && (
            <Alert variant="destructive" className="mt-3">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {target && !resolving && (
            <>
              <TargetPreview target={target} />
              <Button
                type="submit"
                disabled={busy}
                className="mt-3 w-full clip-corner-lg"
              >
                {busy ? (
                  <><Loader2 className="size-4 mr-2 animate-spin" /> {target.kind === "nip29" ? "Adding..." : "Joining..."}</>
                ) : target.kind === "nip29" ? (
                  "Add server"
                ) : (
                  "Join"
                )}
              </Button>
            </>
          )}
        </form>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The "here's where you're going" card shown once a target resolves. */
function TargetPreview({ target }: { target: Target }) {
  const Icon = target.kind === "concord" ? ShieldCheck : Server;
  const accent = target.kind === "concord";
  const title = target.kind === "concord" ? target.name : target.name || target.relay;
  const subtitle =
    target.kind === "concord"
      ? target.about ||
        `Encrypted chat · ${target.channelCount} ${target.channelCount === 1 ? "channel" : "channels"}`
      : target.description || target.relay;

  return (
    <div className="mt-3 flex items-start gap-3 rounded-lg bg-secondary/50 p-3 text-left">
      <Icon className={cn("mt-0.5 size-5 shrink-0", accent ? "text-success" : "text-muted-foreground")} />
      <div className="min-w-0">
        <div className="text-[0.7rem] uppercase tracking-wider text-muted-foreground">
          {target.kind === "concord" ? "You're joining" : "You're adding the server"}
        </div>
        <div className="truncate font-medium">{title || "Untitled"}</div>
        <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
      </div>
    </div>
  );
}
