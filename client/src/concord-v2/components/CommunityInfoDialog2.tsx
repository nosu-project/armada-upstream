import { Shield, Users } from "lucide-react";
import { useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ImageLightbox2 } from "@/concord-v2/components/ImageLightbox2";
import { useDecryptedImage2 } from "@/concord-v2/hooks/useDecryptedImage2";
import type { CommunityMetadata, CommunityV2 } from "@/concord-v2/lib/types";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";

/**
 * Read-only "about this community" dialog: the community's icon, name,
 * description, owner and member count, plus its relay set. Opened by clicking
 * the community name in the channel sidebar header.
 */
export function CommunityInfoDialog2({
  community,
  metadata,
  ownerHex,
  memberCount,
  open,
  onOpenChange,
}: {
  community: CommunityV2 | undefined;
  metadata: CommunityMetadata | undefined;
  ownerHex: string | undefined;
  memberCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md border-0 rounded-none p-0 bg-transparent shadow-none">
        <DialogTitle className="sr-only">Community info</DialogTitle>
        <div className="clip-corner-lg bg-chrome p-6 sm:p-7 max-h-[85vh] overflow-y-auto">
          {community && (
            <InfoBody
              community={community}
              metadata={metadata}
              ownerHex={ownerHex}
              memberCount={memberCount}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function InfoBody({
  community,
  metadata,
  ownerHex,
  memberCount,
}: {
  community: CommunityV2;
  metadata: CommunityMetadata | undefined;
  ownerHex: string | undefined;
  memberCount: number;
}) {
  const iconUrl = useDecryptedImage2(metadata?.icon);
  const name = metadata?.name || community.name;
  const description = metadata?.description?.trim();
  const relays = metadata?.relays ?? community.relays;
  const [iconZoom, setIconZoom] = useState(false);

  return (
    <div className="space-y-5">
      <div className="flex flex-col items-center text-center gap-3">
        {iconUrl ? (
          <button
            type="button"
            className="cursor-zoom-in rounded-2xl"
            aria-label="View icon"
            onClick={() => setIconZoom(true)}
          >
            <img src={iconUrl} alt="" className="size-16 rounded-2xl object-cover" />
          </button>
        ) : (
          <div className="grid size-16 place-items-center rounded-2xl bg-primary/15 text-primary">
            <span className="text-2xl font-semibold">{name[0]?.toUpperCase() ?? "?"}</span>
          </div>
        )}
        <h2 className="text-lg font-semibold leading-tight break-words">{name}</h2>
      </div>

      {iconUrl && iconZoom && <ImageLightbox2 src={iconUrl} onClose={() => setIconZoom(false)} />}

      {description && (
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{description}</p>
      )}

      <div className="space-y-3">
        {ownerHex && <OwnerRow pubkey={ownerHex} />}
        <div className="flex items-center gap-2.5 text-sm">
          <Users className="size-4 shrink-0 text-muted-foreground" />
          <span>
            {memberCount} {memberCount === 1 ? "member" : "members"}
          </span>
        </div>
      </div>

      {relays.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Relays
          </span>
          <ul className="space-y-1">
            {relays.map((r) => (
              <li key={r} className="truncate rounded-md bg-secondary/40 px-2 py-1 text-xs font-mono">
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function OwnerRow({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const displayName = useScopedDisplayName(pubkey, author.data?.metadata);
  return (
    <div className="flex items-center gap-2.5 text-sm">
      <Avatar className="size-6 shrink-0">
        <AvatarImage src={author.data?.metadata?.picture} alt={displayName} />
        <AvatarFallback className="bg-primary/20 text-primary text-[10px]">
          {displayName[0]?.toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1 truncate">{displayName}</span>
      <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
        <Shield className="size-3" />
        Owner
      </span>
    </div>
  );
}
