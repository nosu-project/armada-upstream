import { Lock, UserIcon } from "lucide-react";
import { Link } from "react-router-dom";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { getAvatarShape } from "@/lib/avatarShape";
import { useLoggedInAccounts } from "@/hooks/useLoggedInAccounts";
import { useSwitchAccount } from "@/hooks/useSwitchAccount";

/**
 * Shown at `/c/:communityId` when the ACTIVE account holds no live membership
 * for that community.
 *
 * Membership in Concord is possession of keys, and those keys live in the
 * account's own kind-33302 vault — so "not a member" and "cannot decrypt a
 * single byte of this" are the same statement. The page therefore renders
 * nothing about the community: not its name, not its channel list, not a
 * timeline. There is no non-leaking version of those, and a screen that named
 * the community would be reporting the previous account's vault contents to
 * whoever is signed in now.
 *
 * Distinct from the two states it could be confused with. It is NOT a loading
 * state — the caller only mounts this once the community list has actually
 * resolved and decrypted, because an unresolved list is indistinguishable from
 * an empty one. And it is NOT the invite preview: an invite carries its own
 * key material at `/invite/<naddr>`, which is what makes a preview possible at
 * all, whereas a bare `/c/<id>` carries nothing.
 *
 * The likeliest reason to be here is having switched accounts, so the other
 * accounts on the device are offered directly — each one reloads (see
 * `switchAccount`).
 */
export function CommunityNoAccess() {
  const { currentUser, otherUsers } = useLoggedInAccounts();
  const { switchTo } = useSwitchAccount();

  const displayName = (metadata: { name?: string; display_name?: string }) =>
    metadata.name || metadata.display_name || "Anonymous";

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <Lock className="size-12 text-muted-foreground/50" />
      <h1 className="text-2xl font-bold">You don't have access to this community</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        {currentUser ? (
          <>
            This account isn't a member, so it holds none of the keys needed to read
            anything here. If you joined with a different account, switch to it — or ask
            a member for an invite link.
          </>
        ) : (
          <>Sign in with an account that's a member, or ask a member for an invite link.</>
        )}
      </p>

      {otherUsers.length > 0 && (
        <div className="flex w-full max-w-xs flex-col gap-1">
          <div className="pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Switch account
          </div>
          {otherUsers.map((user) => (
            <button
              key={user.id}
              onClick={() => switchTo(user.id)}
              className="flex items-center gap-2 clip-corner-lg p-2 text-left hover:bg-accent touch:min-h-11"
            >
              <Avatar shape={getAvatarShape(user.metadata)} className="size-8 shrink-0">
                <AvatarImage src={user.metadata.picture} alt={displayName(user.metadata)} />
                <AvatarFallback>
                  {displayName(user.metadata).charAt(0) || <UserIcon className="size-4" />}
                </AvatarFallback>
              </Avatar>
              <span className="truncate text-sm font-medium">{displayName(user.metadata)}</span>
            </button>
          ))}
        </div>
      )}

      <Button asChild variant="outline">
        <Link to="/">Back to base</Link>
      </Button>
    </div>
  );
}
