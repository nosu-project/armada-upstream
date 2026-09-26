import { createPortal } from "react-dom";
import { useParams } from "react-router-dom";

import { HistoryAuditView } from "@/concord/components/HistoryAuditView";
import { useCommunity } from "@/concord/hooks/useCommunityList";
import { useBackOrHome } from "@/hooks/useBackOrHome";

/**
 * The history audit + export tool, as a route.
 *
 * A route rather than a dialog (mirroring {@link DiscordImportPage}): the audit
 * outlives the settings pane its entry point sits in, so owning it here means
 * nothing below can unmount it, and the settings pane yields on its own
 * because the route changed. Portalled to `<body>` because `WizardShell` is
 * `position: fixed` and a transformed ancestor would shrink it to that box.
 */
export function HistoryAuditPage() {
  const { communityId } = useParams<{ communityId: string }>();
  const community = useCommunity(communityId);

  const close = useBackOrHome(communityId ? `/c/${communityId}` : "/");

  // Not joined / still resolving — the community view is the right place to be.
  if (!community) return null;

  return createPortal(<HistoryAuditView community={community} onClose={close} />, document.body);
}
