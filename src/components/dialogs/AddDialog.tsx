import { ChevronDown, ClipboardPaste, Hash, Link2, Loader2, Server, ShieldCheck } from "lucide-react";
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
import { ImportFromDiscordButton } from "@/components/ImportFromDiscord";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useNip29Servers } from "@/hooks/useNip29Servers";
import { useCommunityActions } from "@/concord/hooks/useCommunityActions";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { readClipboardText } from "@/lib/clipboard";
import { claimBuzzInvite, fetchBuzzJoinPolicy, parseBuzzInviteUrl, type BuzzInvite, type BuzzJoinPolicy } from "@/buzz/invite";
import { parseInviteLink, type ParsedInviteLink } from "@/concord/lib/invite";
import { parseGroupNaddr } from "@/lib/nip29";
import { bridgePortalUrl, normalizeRelayUrl, relayToHttpUrl, relayToRouteParam } from "@/lib/platform";

import { cn } from "@/lib/utils";

interface AddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The "Add" wizard, restructured around Concord.
 *
 * The headline act is **starting an end-to-end-encrypted community** — every
 * community is Concord (CORD-01..06). Everything else (joining an existing
 * community, or connecting to a
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
 * The Add wizard's body: the door into founding an encrypted community, plus
 * the smart-paste "escape hatch" for joining via an invite link or NIP-29
 * server URL.
 *
 * Creating is deliberately NOT a form here. It used to be — a name field, a
 * retention picker and a relay list stacked into a dialog, which left no room
 * to ask about the community's icon, banner or description, so every community
 * was born faceless. Those questions now live in the full-screen
 * {@link CreateCommunityWizard} at `/create`, and this is the button that goes
 * there; the pitch stays because this is where the choice is made.
 *
 * Exported for standalone/full-page use. A standalone host must render
 * {@link ArmadaCrestKeyframes} alongside it for the crest animation, and
 * provide `onDone` (called after a successful join/add, and when the create
 * wizard takes over; the dialog uses it to close, a page can no-op).
 */
export function AddBody({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <ArmadaCrest size={84} />

      {/* One line, not three. This is a chooser between three doors — the
          case for an encrypted community belongs on the wizard's own first
          screen, where there's room for it and it isn't in the way. */}
      <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
        gather your crew
      </h2>

      <div className="w-full max-w-sm">
        <Button
          type="button"
          size="lg"
          onClick={() => {
            // Navigation is the whole mechanism, as with the Discord import:
            // the wizard is owned by its route, so this dialog unmounting (via
            // `onDone`, which is what stops a second close button painting over
            // it) cannot take the wizard's state down with it.
            navigate("/create");
            onDone();
          }}
          className="h-12 w-full clip-corner-lg text-base font-medium"
        >
          <ShieldCheck className="size-4 mr-2" />
          Create encrypted community
        </Button>
      </div>

      {/* Coming off Discord: the portal mints the community from a guild's
          channels and history, signed with this user's own key, and hands back
          an invite the escape hatch below accepts. Absent unless the build
          names a portal. What it does and what it costs is explained by the
          import wizard itself, not here. */}
      <ImportFromDiscordSection onOpen={onDone} />

      <EscapeHatch onDone={onDone} />
    </div>
  );
}

/** The Discord-import path: the divider and the button, and nothing else. */
function ImportFromDiscordSection({ onOpen }: { onOpen: () => void }) {
  if (!bridgePortalUrl("/import")) return null;

  return (
    <div className="w-full max-w-sm space-y-2">
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span className="text-[0.7rem] uppercase tracking-wider text-muted-foreground">or</span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <ImportFromDiscordButton onOpen={onOpen} />
    </div>
  );
}

/**
 * The "I already have something" path. One field, one classifier — checked in
 * order: a NIP-29 group identifier (`naddr1...` for kind 39000, optionally with
 * the standardized `?invite=<code>` suffix), a Buzz relay invite
 * (`https://<host>/invite/<code>` with a dotted HMAC code), a Concord invite
 * (`…/invite/<naddr>#…` or bare `naddr#fragment`), or a NIP-29 relay URL.
 */
type Classified =
  | { kind: "buzz"; invite: BuzzInvite; identity: string }
  | { kind: "concord"; invite: ParsedInviteLink; identity: string }
  | { kind: "nip29-group"; group: { relay: string; groupId: string; inviteCode?: string }; identity: string }
  | { kind: "nip29"; relay: string; identity: string }
  | { kind: "unknown"; identity: "" };

function classify(input: string): Classified {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "unknown", identity: "" };
  // A NIP-29 group naddr must be checked before the relay-URL fallback below,
  // which would otherwise swallow a bare naddr as a garbage hostname. Concord
  // bundle naddrs are a different kind (33301), so they fall through to the
  // Concord check below.
  const groupNaddr = parseGroupNaddr(trimmed);
  if (groupNaddr?.relay) {
    const relay = normalizeRelayUrl(groupNaddr.relay);
    if (relay) {
      return {
        kind: "nip29-group",
        group: { relay, groupId: groupNaddr.groupId, inviteCode: groupNaddr.inviteCode },
        identity: `g:${relay}:${groupNaddr.groupId}:${groupNaddr.inviteCode ?? ""}`,
      };
    }
  }
  const buzz = parseBuzzInviteUrl(trimmed);
  if (buzz) return { kind: "buzz", invite: buzz, identity: `buzz:${buzz.host}:${buzz.code}` };
  const invite = parseInviteLink(trimmed);
  if (invite) return { kind: "concord", invite, identity: `c2:${invite.naddr}` };
  const relay = normalizeRelayUrl(trimmed);
  if (relay) return { kind: "nip29", relay, identity: `n:${relay}` };
  return { kind: "unknown", identity: "" };
}

/** What a resolved (validated + loaded) target looks like, for the preview card. */
type Target =
  | { kind: "buzz"; relay: string; name?: string; description?: string; policy?: BuzzJoinPolicy; origin: string }
  | { kind: "concord"; name: string; channelCount: number; relays: string[] }
  | { kind: "nip29-group"; relay: string; groupId: string; inviteCode?: string }
  | { kind: "nip29"; relay: string; name?: string; description?: string };

function EscapeHatch({ onDone }: { onDone: () => void }) {
  const servers = useNip29Servers();
  const { user } = useCurrentUser();
  const navigate = useNavigate();
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const actions = useCommunityActions();

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
        } else if (classified.kind === "concord") {
          const p = await actions.preview({ invite: classified.invite });
          if (cancelled) return;
          setTarget({ kind: "concord", name: p.name, channelCount: p.channelCount, relays: p.relays });
        } else if (classified.kind === "nip29-group") {
          // Nothing to fetch: the naddr itself carries the relay + group id,
          // and the channel page resolves (and joins) the rest.
          if (cancelled) return;
          setTarget({
            kind: "nip29-group",
            relay: classified.group.relay,
            groupId: classified.group.groupId,
            inviteCode: classified.group.inviteCode,
          });
        } else if (classified.kind === "nip29") {
          const relay = classified.relay;
          if (servers.includes(relay)) {
            throw new Error("That server is already in your list.");
          }
          // The NIP-11 document is only a preview of the server's name and
          // description — the actual join is a kind-9021 event over WebSocket
          // (see useJoinGroup), which CORS does not gate. Many relays don't
          // send Access-Control-Allow-Origin on their NIP-11 endpoint, so a
          // failed/blocked fetch here must not block joining a public server.
          const info = await fetch(relayToHttpUrl(relay), {
            headers: { Accept: "application/nostr+json" },
            signal: AbortSignal.timeout(8000),
          })
            .then((res) =>
              res.ok
                ? (res.json() as Promise<{ name?: string; description?: string }>)
                : ({} as { name?: string; description?: string }),
            )
            .catch(() => ({}) as { name?: string; description?: string });
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
  }, [identity, servers]);

  const handleCommit = async () => {
    if (!target) return;
    setError(null);
    setCommitting(true);
    try {
      if (target.kind === "buzz") {
        if (classified.kind !== "buzz") return;
        if (!user) {
          throw new Error("Sign in first. A Buzz invite is claimed with your key.");
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
        // The 10009 list is the only place the rail reads servers from, so
        // this write IS the add — awaited, so a failure surfaces as an error
        // rather than a rail icon that vanishes at the next sync.
        await updateList({ type: "add-server", url: target.relay });
        onDone();
        toast({ title: "Joined", description: target.name || target.relay });
        navigate(`/s/${relayToRouteParam(target.relay)}`);
        return;
      }
      if (target.kind === "concord") {
        if (classified.kind !== "concord") return;
        const { communityId, name } = await actions.join({ invite: classified.invite });
        onDone();
        toast({ title: "Encrypted community joined", description: name });
        navigate(`/c/${encodeURIComponent(communityId)}`);
        return;
      }
      if (target.kind === "nip29-group") {
        // Route to the channel page: joining there is what puts the server on
        // the rail (`add-group` carries it into the 10009 list), and when the
        // naddr carried an `?invite=` code the join banner auto-sends the
        // kind-9021 join request with it pre-filled.
        const query = target.inviteCode ? `?invite=${encodeURIComponent(target.inviteCode)}` : "";
        onDone();
        navigate(`/s/${relayToRouteParam(target.relay)}/${encodeURIComponent(target.groupId)}${query}`);
        return;
      }
      // nip29: already validated in the preview. The kind 10009 list is the
      // only store for added servers, so signing in is a hard requirement and
      // this write IS the add — awaited, so a rejected publish surfaces as an
      // error instead of a rail icon that disappears at the next sync.
      if (!user) {
        throw new Error("Sign in first. Your server list is stored on your Nostr account.");
      }
      await updateList({ type: "add-server", url: target.relay });
      toast({ title: "Server added", description: target.name || target.relay });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setCommitting(false);
    }
  };

  const busy = actions.isJoining || committing;

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
                ) : target.kind === "nip29-group" ? (
                  "Open channel"
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
  const isConcord = target.kind === "concord";
  const Icon = isConcord ? ShieldCheck : target.kind === "nip29-group" ? Hash : Server;
  const title =
    target.kind === "nip29-group"
      ? `#${target.groupId}`
      : target.kind === "nip29" || target.kind === "buzz"
        ? target.name || target.relay
        : target.name;
  const subtitle =
    target.kind === "nip29-group"
      ? target.relay
      : target.kind === "buzz"
        ? target.description || `Buzz workspace · ${target.relay}`
        : target.kind === "nip29"
          ? target.description || target.relay
          : `Encrypted community · ${target.channelCount} ${target.channelCount === 1 ? "channel" : "channels"}`;

  return (
    <div className="mt-3 flex items-start gap-3 rounded-lg bg-secondary/50 p-3 text-left">
      <Icon className={cn("mt-0.5 size-5 shrink-0", isConcord ? "text-success" : "text-muted-foreground")} />
      <div className="min-w-0">
        <div className="text-[0.7rem] uppercase tracking-wider text-muted-foreground">
          {isConcord ? "You're joining" : target.kind === "nip29-group" ? "You're opening the channel" : target.kind === "buzz" ? "You're joining the workspace" : "You're adding the server"}
        </div>
        <div className="truncate font-medium">{title || "Untitled"}</div>
        <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
      </div>
    </div>
  );
}
