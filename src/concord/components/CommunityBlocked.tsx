import { ShieldOff } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { FormattedMessage } from "@/i18n";

/**
 * Shown at `/c/:communityId` when the community is on the blocklist
 * (`blocklistStore.ts`). Mounted in place of the community page, so nothing of
 * it is read, synced or announced. Shows nothing about the community.
 */
export function CommunityBlocked() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <ShieldOff className="size-12 text-muted-foreground/50" />
      <h1 className="text-2xl font-bold">
        <FormattedMessage id="communityBlocked.title" defaultMessage="This community is unavailable in Armada" />
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">
        <FormattedMessage
          id="communityBlocked.description"
          defaultMessage="Armada has blocked it for a violation of its content policy. It can't be opened or joined here."
        />
      </p>
      <Button asChild variant="outline">
        <Link to="/"><FormattedMessage id="communityBlocked.backToBase" defaultMessage="Back to base" /></Link>
      </Button>
    </div>
  );
}
