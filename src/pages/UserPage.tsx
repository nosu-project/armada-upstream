import { Loader2, MessageSquare } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { JoinButton } from "@/components/auth/JoinButton";
import { ServerRail } from "@/components/layout/ServerRail";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useAcceptedDms } from "@/hooks/useAcceptedDms";
import { useAuthor } from "@/hooks/useAuthor";
import { useClosedDms } from "@/hooks/useClosedDms";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNip05Resolve } from "@/hooks/useNip05Resolve";
import { useStartedDms } from "@/hooks/useStartedDms";
import { getAvatarShape } from "@/lib/avatarShape";
import { parseNip05Address } from "@/lib/nip05Address";
import { resolvePubkey } from "@/lib/resolvePubkey";
import { tryNpubEncode } from "@/lib/safeNip19";
import { NotFound } from "@/pages/NotFound";

/**
 * A person's public chat link — `/<npub>`, `/<name@domain>`, or `/<domain>`
 * (the NIP-05 root user, `_@domain`). Share it with someone who isn't on
 * Armada and it says who they'd be talking to and offers them an account;
 * open it signed in and it's just a shortcut to the DM thread.
 *
 * This is the only single-segment dynamic route in the app, so it sits in
 * front of the `*` 404 for every unclaimed one-segment path. That's why an
 * identifier is only recognized when it DECODES (npub/nprofile/hex) or is
 * shaped like a NIP-05 address — a dot in the domain is what separates
 * `/ditto.pub` from `/setttings`, and everything else falls through to the
 * same 404 the splat route would have rendered.
 */
export function UserPage() {
  const { user: identifier = "" } = useParams<{ user: string }>();
  const { user } = useCurrentUser();
  const navigate = useNavigate();
  const { accept } = useAcceptedDms();
  const { reopen } = useClosedDms();
  const { start } = useStartedDms();

  const direct = useMemo(() => resolvePubkey(identifier), [identifier]);
  // Only reached for a segment that didn't decode, so a valid npub never costs
  // a well-known fetch.
  const address = useMemo(
    () => (direct ? undefined : parseNip05Address(identifier)),
    [direct, identifier],
  );
  const nip05 = useNip05Resolve(address);

  const pubkey = direct ?? nip05.data ?? undefined;
  const npub = pubkey ? tryNpubEncode(pubkey) : undefined;
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;

  // Never "Anonymous": until the kind 0 lands, the address the visitor followed
  // is a truer name for this person than a placeholder is.
  const shortNpub = npub ? `${npub.slice(0, 12)}…${npub.slice(-6)}` : "";
  const displayName =
    metadata?.name || metadata?.display_name || address?.display || shortNpub;

  // Signed in, so there's nothing to invite anyone to — open the conversation.
  // Runs on the transition into a signed-in state too, which is how joining
  // from the button below lands in the thread: the login dialog belongs to
  // this page and never navigates, so this effect is still mounted when
  // `user` appears.
  const opened = useRef(false);
  useEffect(() => {
    if (!user || !pubkey || opened.current) return;
    // Someone opening their own link has no conversation to open.
    if (pubkey === user.pubkey) {
      opened.current = true;
      navigate("/dms", { replace: true });
      return;
    }
    if (!npub) return;
    opened.current = true;
    // Following a chat link is the same commitment as picking someone in the
    // compose pane — out of the request tier, out of the closed pile — plus
    // one thing that flow doesn't do: keep the row after we navigate away, so
    // the person who sent the link is still in the list tomorrow.
    reopen(pubkey);
    accept(pubkey);
    start(pubkey);
    navigate(`/dms/${npub}`, { replace: true });
  }, [user, pubkey, npub, navigate, reopen, accept, start]);

  // Not a person's identifier at all: this is an ordinary unrouted path.
  if (!direct && !address) {
    return <NotFound />;
  }

  return (
    <>
      <ServerRail />
      <main className="flex-1 min-w-0 flex flex-col items-center justify-center gap-4 p-8 text-center">
        {!pubkey && nip05.isPending ? (
          <>
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
            <p className="text-muted-foreground">Looking up {address?.display}…</p>
          </>
        ) : !pubkey ? (
          <>
            <MessageSquare className="size-12 text-muted-foreground" />
            <h1 className="text-2xl font-bold">No such person</h1>
            <p className="max-w-md text-muted-foreground">
              {nip05.isError
                ? <>Couldn’t reach {address?.domain} to look up {address?.display}.</>
                : <>{address?.display} isn’t a Nostr account we could find.</>}
            </p>
            <Button asChild>
              <Link to="/">Back to base</Link>
            </Button>
          </>
        ) : user ? (
          <>
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
            <p className="text-muted-foreground">Opening your conversation…</p>
          </>
        ) : (
          <>
            <Avatar shape={getAvatarShape(metadata)} className="size-24 border-[3px] border-background">
              <AvatarImage src={metadata?.picture} alt={displayName} />
              <AvatarFallback className="bg-primary/20 text-primary text-3xl">
                {displayName[0]?.toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <h1 className="text-2xl font-bold">
              Chat with <span className="break-words">{displayName}</span> on Armada
            </h1>
            <p className="max-w-md text-muted-foreground">
              Armada is end-to-end encrypted messaging on Nostr. Create an account or sign
              in and this conversation is waiting for you.
            </p>
            <JoinButton size="lg" className="h-12 w-full max-w-xs clip-corner-lg text-base font-medium" />
          </>
        )}
      </main>
    </>
  );
}

export default UserPage;
