import { Loader2, MessageSquare } from "lucide-react";
import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { JoinButton } from "@/components/auth/JoinButton";
import { ServerRail } from "@/components/layout/ServerRail";
import { ProfileDialog } from "@/components/profile/ProfileDialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNip05Resolve } from "@/hooks/useNip05Resolve";
import { getAvatarShape } from "@/lib/avatarShape";
import { parseNip05Address } from "@/lib/nip05Address";
import { resolvePubkey } from "@/lib/resolvePubkey";
import { tryNpubEncode } from "@/lib/safeNip19";
import { NotFound } from "@/pages/NotFound";

/**
 * A person, at `/<npub>`, `/<nprofile>`, `/<name@domain>` or `/<domain>` (the
 * NIP-05 root user, `_@domain`). The bare NIP-19 path is the convention the
 * Nostr ecosystem already links to and that other clients already route, so
 * this deliberately has no prefix segment of its own to make it Armada's.
 *
 * What it shows depends on who's looking, because the same link serves two
 * purposes. Signed out it's a share link — it says who you'd be talking to and
 * offers you an account. Signed in it's the person's profile, opened as a
 * dialog over the app so closing it puts you back where you were rather than
 * anywhere this had to pick.
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

  // Not a person's identifier at all: this is an ordinary unrouted path.
  if (!direct && !address) {
    return <NotFound />;
  }

  // Closing the profile is a step back, not a destination — the dialog is
  // always opened from somewhere. A cold load has nowhere to go back TO, so
  // that one lands home.
  const closeProfile = () =>
    window.history.length > 1 ? navigate(-1) : navigate("/");

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
          // The profile below covers this. Nothing to say behind it.
          null
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
      {user && pubkey && <ProfileDialog pubkey={pubkey} onClose={closeProfile} />}
    </>
  );
}

export default UserPage;
