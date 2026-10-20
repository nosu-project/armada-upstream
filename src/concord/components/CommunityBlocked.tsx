import {
  ArmadaWreck,
  ArmadaWreckKeyframes,
  WRECK_SCOPE,
  WreckSky,
  wreckQuake,
  wreckRise,
} from "@/components/brand/ArmadaWreck";
import { GameOverTitle } from "@/components/brand/GameOverTitle";
import { useWreckMusic } from "@/components/brand/useWreckMusic";
import { FormattedMessage } from "@/i18n";

/**
 * Shown at `/c/:communityId` when the community is on the blocklist
 * (`blocklistStore.ts`). Mounted in place of the community page, so nothing of
 * it is read, synced or announced. Shows nothing about the community.
 */
export function CommunityBlocked() {
  useWreckMusic();

  return (
    <div
      className={`${WRECK_SCOPE} relative flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-4 overflow-hidden p-8 text-center`}
    >
      <ArmadaWreckKeyframes />
      <WreckSky />
      <div className="relative" style={wreckQuake}>
        <ArmadaWreck className="h-auto w-[min(20rem,80vw)]" />
      </div>
      <h1 className="relative" style={wreckRise(0)}>
        <GameOverTitle className="h-auto w-[min(24rem,80vw)]" />
        <span className="sr-only">
          <FormattedMessage id="communityBlocked.title" defaultMessage="This community is unavailable in Armada" />
        </span>
      </h1>
    </div>
  );
}
