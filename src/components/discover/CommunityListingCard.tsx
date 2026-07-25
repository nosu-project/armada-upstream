import { ArrowRight, ShieldCheck } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useAuthor } from "@/hooks/useAuthor";
import { inviteUrlToLocalRoute, type PublicListing } from "@/concord-v2/lib/publicListing";
import { getAvatarShape } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
import { cn } from "@/lib/utils";

interface CommunityListingCardProps {
  listing: PublicListing;
  className?: string;
}

/**
 * A public Concord community listing (kind 30456) rendered as a discover card:
 * icon, name, description, topics, the publishing owner, and a Join button that
 * routes to the embedded invite link (which resolves + joins the encrypted
 * community, prompting sign-in first if needed).
 */
export function CommunityListingCard({ listing, className }: CommunityListingCardProps) {
  const navigate = useNavigate();
  const author = useAuthor(listing.author);
  const metadata = author.data?.metadata;
  const displayName = getDisplayName(metadata, listing.author);
  const initial = listing.name.trim().charAt(0).toUpperCase() || "·";

  const onJoin = () => navigate(inviteUrlToLocalRoute(listing.inviteUrl));

  return (
    <div
      className={cn(
        "block w-full rounded-2xl border border-border bg-secondary/30 overflow-hidden",
        className,
      )}
    >
      <div className="px-3.5 py-3 space-y-2.5">
        {/* Header: icon + name */}
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-success">
            {listing.icon ? (
              <img src={listing.icon} alt="" className="size-full object-cover" />
            ) : (
              <span className="text-sm font-semibold">{initial}</span>
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold truncate leading-tight">{listing.name}</p>
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <ShieldCheck className="size-3 shrink-0" />
              Encrypted community
            </span>
          </div>
        </div>

        {listing.description && (
          <p className="text-sm text-muted-foreground line-clamp-3">{listing.description}</p>
        )}

        {listing.topics.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {listing.topics.slice(0, 6).map((t) => (
              <span
                key={t}
                className="rounded-full bg-secondary px-2 py-px text-[11px] text-muted-foreground"
              >
                #{t}
              </span>
            ))}
          </div>
        )}

        {/* Publisher byline */}
        <ProfilePreviewCard pubkey={listing.author}>
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground min-w-0"
          >
            <Avatar shape={getAvatarShape(metadata)} className="size-4 shrink-0">
              <AvatarImage src={metadata?.picture} alt={displayName} />
              <AvatarFallback className="bg-primary/20 text-primary text-[8px]">
                {displayName[0]?.toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="truncate">shared by {displayName}</span>
          </button>
        </ProfilePreviewCard>

        <Button className="w-full clip-corner-lg" onClick={onJoin}>
          Join
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}
