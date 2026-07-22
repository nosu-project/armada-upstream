import { Loader2, PartyPopper, ServerCrash } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { JoinButton } from "@/components/auth/JoinButton";
import { ServerRail } from "@/components/layout/ServerRail";
import { Button } from "@/components/ui/button";
import {
  buzzInviteFromRelay,
  claimBuzzInvite,
  fetchBuzzJoinPolicy,
  type BuzzJoinPolicy,
} from "@/buzz/invite";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { relayToHttpUrl, relayToRouteParam } from "@/lib/platform";

/**
 * Landing page for a Buzz relay invite on the Armada host —
 * `/invite/<code>?r=<relay-host>`. Unlike a Concord invite, a Buzz invite is
 * an HTTP claim against the relay (the code is a dotted HMAC token, not an
 * naddr); `?r=` names the relay because the code doesn't encode it. Once
 * signed in we claim membership, add the server, and dive in. A relay that
 * requires a join policy shows its terms first.
 */
export function BuzzInvitePage() {
  const { naddr: code } = useParams<{ naddr: string }>();
  const [params] = useSearchParams();
  const relayParam = params.get("r");
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const { updateConfig } = useAppContext();
  const { mutateAsync: updateList } = useUpdateUserGroupList();

  const invite = useMemo(
    () => (code && relayParam ? buzzInviteFromRelay(code, relayParam) : undefined),
    [code, relayParam],
  );

  const [previewName, setPreviewName] = useState<string | null>(null);
  const [policy, setPolicy] = useState<BuzzJoinPolicy | null | undefined>(undefined);
  const [policyAccepted, setPolicyAccepted] = useState(false);
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempted = useRef(false);

  // Preview the relay (NIP-11 name) and load its join policy, even before
  // sign-in, so the invitee sees where they're headed.
  useEffect(() => {
    if (!invite) return;
    let cancelled = false;
    fetch(relayToHttpUrl(invite.relayUrl), {
      headers: { Accept: "application/nostr+json" },
      signal: AbortSignal.timeout(8000),
    })
      .then((res): Promise<{ name?: string }> => (res.ok ? res.json() : Promise.resolve({})))
      .then((info) => !cancelled && setPreviewName(info.name ?? null))
      .catch(() => undefined);
    fetchBuzzJoinPolicy(invite.origin)
      .then((p) => !cancelled && setPolicy(p ?? null))
      .catch(() => !cancelled && setPolicy(null));
    return () => {
      cancelled = true;
    };
  }, [invite]);

  const claim = useMemo(
    () => async () => {
      if (!invite || !user || attempted.current) return;
      if (policy && !policyAccepted) {
        setError("Accept the server's terms to join.");
        return;
      }
      if (policy?.ageAttestationRequired && !ageConfirmed) {
        setError("This server requires an age confirmation to join.");
        return;
      }
      attempted.current = true;
      setClaiming(true);
      setError(null);
      try {
        await claimBuzzInvite(user.signer, invite, {
          policy: policy ?? undefined,
          ageConfirmed,
        });
        updateConfig((current) =>
          current.addedRelays.includes(invite.relayUrl)
            ? current
            : { ...current, addedRelays: [...current.addedRelays, invite.relayUrl] },
        );
        updateList({ type: "add-server", url: invite.relayUrl }).catch((err) =>
          console.warn("Failed to sync server to group list:", err));
        toast({ title: "Joined", description: previewName || invite.host });
        navigate(`/s/${relayToRouteParam(invite.relayUrl)}`, { replace: true });
      } catch (e) {
        attempted.current = false; // allow a retry
        setError(e instanceof Error ? e.message : "Couldn't join with that invite link.");
      } finally {
        setClaiming(false);
      }
    },
    [invite, user, policy, policyAccepted, ageConfirmed, previewName, updateConfig, updateList, navigate],
  );

  // Auto-join once signed in when there's no policy to accept; a policy needs an
  // explicit tick, so wait for the button then.
  useEffect(() => {
    if (invite && user && policy === null && !attempted.current) void claim();
  }, [invite, user, policy, claim]);

  return (
    <>
      <ServerRail />
      <main className="flex-1 min-w-0 flex flex-col items-center justify-center gap-4 p-8 text-center">
        {!invite ? (
          <>
            <ServerCrash className="size-12 text-muted-foreground" />
            <h1 className="text-2xl font-bold">Invite link didn’t work</h1>
            <p className="max-w-md text-muted-foreground">
              This invite link is malformed or from a newer client.
            </p>
            <Button asChild>
              <Link to="/">Back to base</Link>
            </Button>
          </>
        ) : error ? (
          <>
            <ServerCrash className="size-12 text-destructive" />
            <h1 className="text-2xl font-bold">Invite link didn’t work</h1>
            <p className="max-w-md text-muted-foreground">{error}</p>
            <Button onClick={() => void claim()} disabled={claiming || !user}>
              Try again
            </Button>
          </>
        ) : (
          <>
            <PartyPopper className="size-12 text-primary" />
            <h1 className="text-2xl font-bold">
              You’re invited to{" "}
              {previewName ? <span>{previewName}</span> : invite.host}
            </h1>
            {!user ? (
              <>
                <p className="max-w-md text-muted-foreground">
                  Create an account or sign in to accept the invite.
                </p>
                <JoinButton size="lg" className="h-12 w-full max-w-xs clip-corner-lg text-base font-medium" />
              </>
            ) : policy === undefined || (policy === null && claiming) ? (
              <>
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
                <p className="text-muted-foreground">Joining {previewName || invite.host}…</p>
              </>
            ) : policy ? (
              <div className="w-full max-w-sm space-y-3 text-left">
                <label className="flex items-start gap-2 text-sm text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={policyAccepted}
                    onChange={(e) => setPolicyAccepted(e.target.checked)}
                  />
                  <span>
                    I accept this server’s{" "}
                    {policy.termsMarkdown ? (
                      <a
                        href={`${invite.origin}/api/join-policy/terms`}
                        target="_blank"
                        rel="noreferrer"
                        className="underline hover:text-foreground"
                      >
                        Terms of Service
                      </a>
                    ) : (
                      "terms"
                    )}
                    {policy.privacyMarkdown && (
                      <>
                        {" "}and{" "}
                        <a
                          href={`${invite.origin}/api/join-policy/privacy`}
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
                {policy.ageAttestationRequired && (
                  <label className="flex items-start gap-2 text-sm text-muted-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={ageConfirmed}
                      onChange={(e) => setAgeConfirmed(e.target.checked)}
                    />
                    <span>I confirm I meet this server’s minimum age requirement.</span>
                  </label>
                )}
                <Button
                  onClick={() => void claim()}
                  disabled={claiming || !policyAccepted || (policy.ageAttestationRequired && !ageConfirmed)}
                  className="w-full clip-corner-lg"
                >
                  {claiming ? <><Loader2 className="size-4 mr-2 animate-spin" /> Joining…</> : "Join"}
                </Button>
              </div>
            ) : (
              <>
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
                <p className="text-muted-foreground">Joining {previewName || invite.host}…</p>
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}

export default BuzzInvitePage;
