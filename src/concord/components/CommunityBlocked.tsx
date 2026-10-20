import { Link } from "react-router-dom";

import {
  ArmadaWreck,
  ArmadaWreckKeyframes,
  WRECK_SCOPE,
  WreckSky,
  wreckQuake,
  wreckRise,
} from "@/components/brand/ArmadaWreck";
import { Button } from "@/components/ui/button";
import { FormattedMessage } from "@/i18n";

/**
 * Shown at `/c/:communityId` when the community is on the blocklist
 * (`blocklistStore.ts`). Mounted in place of the community page, so nothing of
 * it is read, synced or announced. Shows nothing about the community.
 */
export function CommunityBlocked() {
  return (
    <div
      className={`${WRECK_SCOPE} relative flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-4 overflow-hidden p-8 text-center`}
    >
      <ArmadaWreckKeyframes />
      <WreckSky />
      <div className="relative" style={wreckQuake}>
        <ArmadaWreck className="h-auto w-[min(20rem,80vw)]" />
      </div>
      <h1 className="relative text-2xl font-bold" style={wreckRise(0)}>
        <FormattedMessage id="communityBlocked.title" defaultMessage="This community is unavailable in Armada" />
      </h1>
      <p className="relative max-w-md text-sm text-muted-foreground" style={wreckRise(0.15)}>
        <FormattedMessage
          id="communityBlocked.description"
          defaultMessage="Armada has blocked it for a violation of its content policy. It can't be opened or joined here."
        />
      </p>
      <Button asChild variant="secondary" className="relative" style={wreckRise(0.3)}>
        <Link to="/"><FormattedMessage id="communityBlocked.backToBase" defaultMessage="Back to base" /></Link>
      </Button>
    </div>
  );
}
