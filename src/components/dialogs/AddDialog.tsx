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
import { RelayListEditor } from "@/components/RelayListEditor";
import { useConcordActions } from "@/concord-v1/hooks/useConcordActions";
import { useCommunityActions2, useCreateRelayCandidates2 } from "@/concord-v2/hooks/useCommunityActions2";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { readClipboardText } from "@/lib/clipboard";
import { claimBuzzInvite, fetchBuzzJoinPolicy, parseBuzzInviteUrl, type BuzzInvite, type BuzzJoinPolicy } from "@/buzz/invite";
import { classifyAddInput, type ConcordInvite } from "@/concord-v1/lib/concord";
import { parseInviteLink, type ParsedInviteLink } from "@/concord-v2/lib/invite";
import { PINNED_RAIL_RELAYS, relayToHttpUrl, relayToRouteParam } from "@/lib/platform";
import { cn } from "@/lib/utils";

interface AddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The "Add" wizard, restructured around Concord.
 *
 * The headline act is **starting an end-to-end-encrypted community** — every
 * NEW community is Concord V2 (CORD-01..06); V1 creation is retired, though
 * existing V1 communities keep working and V1 invites still join. Everything
 * else (joining an existing community — V2 or V1 — or connecting to a
 * trust-the-host NIP-29 relay) folds into a single smaller "escape hatch": one
 * smart-paste field that figures out what you gave it and does the right thing.
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

/**
 * The Add wizard's body: create an encrypted community, plus the smart-paste
 * "escape hatch" for joining via an invite link or NIP-29 server URL.
 *
 * Exported for standalone/full-page use (the welcome-page onboarding renders
 * it inline). A standalone host must render {@link ArmadaCrestKeyframes}
 * alongside it for the crest animation, and provide `onDone` (called after a
 * successful create/join/add; the dialog uses it to close, a page can no-op).
 */
export function AddBody({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const { create, isCreating } = useCommunityActions2();

  const [name, setName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  // Advanced: which relays the community is minted on. `null` = untouched (the
  // create path picks its own default); once the user edits, `relays` holds the
  // explicit set. The candidate query (gated on the menu being open) resolves
  // the same default for pre-selection.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [relays, setRelays] = useState<string[] | null>(null);
  const { data: candidates } = useCreateRelayCandidates2(advancedOpen);
  const effectiveRelays = relays ?? candidates ?? [];

  const handleCreate = async () => {
    setCreateError(null);
    try {
      // New communities are always Concord V2.
      const { communityId, name: created } = await create({
        name: name.trim(),
        relays: relays ?? undefined,
      });
      onDone();
      toast({ title: "Encrypted community ready", description: created });
      navigate(`/c/${encodeURIComponent(communityId)}`);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Couldn't create the community.");
    }
  };

  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <ArmadaCrest size={84} />

      <div className="space-y-3">
        <div>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            gather your crew
          </h2>
          <p className="font-mono text-base lowercase tracking-tight text-muted-foreground">
            start an encrypted community
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          Serverless and end-to-end-encrypted. No host can read it; your key is
          your membership. You become the owner.
        </p>
      </div>

      <div className="w-full max-w-sm space-y-3">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim() && !isCreating) {
              e.preventDefault();
              handleCreate();
            }
          }}
          placeholder="Name your community"
          aria-label="Community name"
          autoComplete="off"
          autoFocus
          className="h-12 text-base"
        />

        {createError && (
          <Alert variant="destructive">
            <AlertDescription>{createError}</AlertDescription>
          </Alert>
        )}

        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <div className="flex gap-2">
            <Button
              type="button"
              size="lg"
              onClick={handleCreate}
              disabled={isCreating || !name.trim()}
              className="h-12 flex-1 clip-corner-lg text-base font-medium"
            >
              {isCreating ? (
                <><Loader2 className="size-4 mr-2 animate-spin" /> Creating...</>
              ) : (
                <><ShieldCheck className="size-4 mr-2" /> Create encrypted community</>
              )}
            </Button>

            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Choose relays"
                className="h-12 w-12 shrink-0"
              >
                <ChevronDown className={cn("size-5 transition-transform", advancedOpen && "rotate-180")} />
              </Button>
            </CollapsibleTrigger>
          </div>

          <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
            <p className="mb-2 mt-3 text-left text-xs text-muted-foreground">
              Where this community lives. Members read and write here, so pick
              relays that accept your writes. An auth-only or DM-only relay can
              reject the genesis and strand the create.
            </p>
            <RelayListEditor
              relays={effectiveRelays}
              onChange={setRelays}
              onReset={candidates ? () => setRelays(candidates) : undefined}
              emptyText="Add at least one relay to host this community."
            />
          </CollapsibleContent>
        </Collapsible>
      </div>

      <EscapeHatch onDone={onDone} />
    </div>
  );
}

/**
 * The "I already have something" path. One field, one classifier — checked in
 * order: a Buzz relay invite (`https://<host>/invite/<code>` with a dotted
 * HMAC code), a Concord V2 invite (`…/invite/<naddr>#…` or bare
 * `naddr#fragment`), a Concord V1 invite (link or bare token), or a NIP-29
 * relay URL.
 */
type Classified =
  | { kind: "buzz"; invite: BuzzInvite; identity: string }
  | { kind: "concord2"; invite: ParsedInviteLink; identity: string }
  | { kind: "concord1"; invite: ConcordInvite; identity: string }
  | { kind: "nip29"; relay: string; identity: string }
  | { kind: "unknown"; identity: "" };

function classify(input: string): Classified {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "unknown", identity: "" };
  const buzz = parseBuzzInviteUrl(trimmed);
  if (buzz) return { kind: "buzz", invite: buzz, identity: `buzz:${buzz.host}:${buzz.code}` };
  const v2 = parseInviteLink(trimmed);
  if (v2) return { kind: "concord2", invite: v2, identity: `c2:${v2.naddr}` };
  const v1 = classifyAddInput(trimmed);
  if (v1.kind === "concord") return { kind: "concord1", invite: v1.invite, identity: `c1:${v1.invite.token}` };
  if (v1.kind === "nip29") return { kind: "nip29", relay: v1.relay, identity: `n:${v1.relay}` };
  return { kind: "unknown", identity: "" };
}

/** What a resolved (validated + loaded) target looks like, for the preview card. */
type Target =
  | { kind: "buzz"; relay: string; name?: string; description?: string; policy?: BuzzJoinPolicy; origin: string }
  | { kind: "concord2"; name: string; channelCount: number; relays: string[] }
  | { kind: "concord1"; name: string; about?: string; channelCount: number; relays: string[] }
  | { kind: "nip29"; relay: string; name?: string; description?: string };

function EscapeHatch({ onDone }: { onDone: () => void }) {
  const { config, updateConfig } = useAppContext();
  const { user } = useCurrentUser();
  const navigate = useNavigate();
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const v1 = useConcordActions();
  const v2 = useCommunityActions2();

  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [committing, setCommitting] = useState(false);
  // Buzz join-policy acceptance (only rendered when the relay requires one).
  const [policyAccepted, setPolicyAccepted] = useState(false);
  const [ageConfirmed, setAgeConfirmed] = useState(false);

  const classified = useMemo(() => classify(value), [value]);
  const identity = classified.identity;

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
  useEffect(() => {
    setTarget(null);
    setError(null);
    setPolicyAccepted(false);
    setAgeConfirmed(false);
    if (!identity) {
      setResolving(false);
      return;
    }

    let cancelled = false;
    setResolving(true);
    const timer = setTimeout(async () => {
      try {
        if (classified.kind === "buzz") {
          const relay = classified.invite.relayUrl;
          const [info, policy] = await Promise.all([
            fetch(relayToHttpUrl(relay), {
              headers: { Accept: "application/nostr+json" },
              signal: AbortSignal.timeout(8000),
            })
              .then((res) =>
                res.ok
                  ? (res.json() as Promise<{ name?: string; description?: string }>)
                  : ({} as { name?: string; description?: string }),
              )
              .catch(() => ({}) as { name?: string; description?: string }),
            fetchBuzzJoinPolicy(classified.invite.origin).catch(() => undefined),
          ]);
          if (cancelled) return;
          setTarget({
            kind: "buzz",
            relay,
            name: info.name,
            description: info.description,
            policy,
            origin: classified.invite.origin,
          });
        } else if (classified.kind === "concord2") {
          const p = await v2.preview({ invite: classified.invite });
          if (cancelled) return;
          setTarget({ kind: "concord2", name: p.name, channelCount: p.channelCount, relays: p.relays });
        } else if (classified.kind === "concord1") {
          const { community, channelCount } = await v1.previewInvite({ invite: classified.invite });
          if (cancelled) return;
          setTarget({
            kind: "concord1",
            name: community.name,
            about: community.about,
            channelCount,
            relays: community.relays,
          });
        } else if (classified.kind === "nip29") {
          const relay = classified.relay;
          if (PINNED_RAIL_RELAYS.includes(relay) || config.addedRelays.includes(relay)) {
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
            : classified.kind === "nip29"
              ? "Could not reach that relay's NIP-11 endpoint. Check the URL and your network."
              : "Couldn't load that invite.",
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
    // matter (plus the lists that gate nip29 dupes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, config.addedRelays]);

  const handleCommit = async () => {
    if (!target) return;
    setError(null);
    setCommitting(true);
    try {
      if (target.kind === "buzz") {
        if (classified.kind !== "buzz") return;
        if (!user) {
          throw new Error("Sign in first — a Buzz invite is claimed with your key.");
        }
        if (target.policy && !policyAccepted) {
          throw new Error("Accept the server's terms to join.");
        }
        if (target.policy?.ageAttestationRequired && !ageConfirmed) {
          throw new Error("This server requires an age confirmation to join.");
        }
        await claimBuzzInvite(user.signer, classified.invite, {
          policy: target.policy,
          ageConfirmed,
        });
        updateConfig((current) =>
          current.addedRelays.includes(target.relay)
            ? current
            : { ...current, addedRelays: [...current.addedRelays, target.relay] },
        );
        updateList({ type: "add-server", url: target.relay }).catch((err) =>
          console.warn("Failed to sync server to group list:", err));
        onDone();
        toast({ title: "Joined", description: target.name || target.relay });
        navigate(`/s/${relayToRouteParam(target.relay)}`);
        return;
      }
      if (target.kind === "concord2") {
        if (classified.kind !== "concord2") return;
        const { communityId, name } = await v2.join({ invite: classified.invite });
        onDone();
        toast({ title: "Encrypted community joined", description: name });
        navigate(`/c/${encodeURIComponent(communityId)}`);
        return;
      }
      if (target.kind === "concord1") {
        if (classified.kind !== "concord1") return;
        const community = await v1.joinViaInvite({ invite: classified.invite });
        onDone();
        toast({ title: "Encrypted chat joined", description: community.name });
        navigate(`/c1/${encodeURIComponent(community.communityId)}`);
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

  const busy = v1.isWorking || v2.isJoining || committing;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full max-w-sm">
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
              {classified.kind === "nip29" ? "Reaching server..." : "Loading invite..."}
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
              {/* Buzz join policy: operator-configured terms must be accepted
                  before the claim; the receipt is bound to the invite code. */}
              {target.kind === "buzz" && target.policy && (
                <div className="mt-3 space-y-2 text-left text-xs text-muted-foreground">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={policyAccepted}
                      onChange={(e) => setPolicyAccepted(e.target.checked)}
                    />
                    <span>
                      I accept this server's{" "}
                      {target.policy.termsMarkdown ? (
                        <a
                          href={`${target.origin}/api/join-policy/terms`}
                          target="_blank"
                          rel="noreferrer"
                          className="underline hover:text-foreground"
                        >
                          Terms of Service
                        </a>
                      ) : (
                        "terms"
                      )}
                      {target.policy.privacyMarkdown && (
                        <>
                          {" "}and{" "}
                          <a
                            href={`${target.origin}/api/join-policy/privacy`}
                            target="_blank"
                            rel="noreferrer"
                            className="underline hover:text-foreground"
                          >
                            Privacy Policy
                          </a>
                        </>
                      )}
                      .
                    </span>
                  </label>
                  {target.policy.ageAttestationRequired && (
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={ageConfirmed}
                        onChange={(e) => setAgeConfirmed(e.target.checked)}
                      />
                      <span>I confirm I meet this server's minimum age requirement.</span>
                    </label>
                  )}
                </div>
              )}
              <Button
                type="submit"
                disabled={
                  busy ||
                  (target.kind === "buzz" && !user) ||
                  (target.kind === "buzz" && Boolean(target.policy) && !policyAccepted) ||
                  (target.kind === "buzz" && Boolean(target.policy?.ageAttestationRequired) && !ageConfirmed)
                }
                className="mt-3 w-full clip-corner-lg"
              >
                {busy ? (
                  <><Loader2 className="size-4 mr-2 animate-spin" /> {target.kind === "nip29" ? "Adding..." : "Joining..."}</>
                ) : target.kind === "nip29" ? (
                  "Add server"
                ) : target.kind === "buzz" && !user ? (
                  "Sign in to join"
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
  const isConcord = target.kind === "concord1" || target.kind === "concord2";
  const Icon = isConcord ? ShieldCheck : Server;
  const title = target.kind === "nip29" || target.kind === "buzz" ? target.name || target.relay : target.name;
  const subtitle =
    target.kind === "buzz"
      ? target.description || `Buzz workspace · ${target.relay}`
      : target.kind === "nip29"
        ? target.description || target.relay
        : (target.kind === "concord1" && target.about) ||
          `Encrypted community · ${target.channelCount} ${target.channelCount === 1 ? "channel" : "channels"}`;

  return (
    <div className="mt-3 flex items-start gap-3 rounded-lg bg-secondary/50 p-3 text-left">
      <Icon className={cn("mt-0.5 size-5 shrink-0", isConcord ? "text-success" : "text-muted-foreground")} />
      <div className="min-w-0">
        <div className="text-[0.7rem] uppercase tracking-wider text-muted-foreground">
          {isConcord ? "You're joining" : target.kind === "buzz" ? "You're joining the workspace" : "You're adding the server"}
        </div>
        <div className="truncate font-medium">{title || "Untitled"}</div>
        <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
      </div>
    </div>
  );
}
