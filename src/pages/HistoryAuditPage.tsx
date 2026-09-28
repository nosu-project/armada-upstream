import { createPortal } from "react-dom";
import { useParams } from "react-router-dom";

import { HistoryAuditView } from "@/concord/components/HistoryAuditView";
import { useCommunity } from "@/concord/hooks/useCommunityList";
import { useBackOrHome } from "@/hooks/useBackOrHome";

/**
 * History audit + export as a route (like {@link DiscordImportPage}), portalled
 * to `<body>` for `WizardShell`'s `position: fixed`.
 */
export function HistoryAuditPage() {
  const { communityId } = useParams<{ communityId: string }>();
  const community = useCommunity(communityId);

  const close = useBackOrHome(communityId ? `/c/${communityId}` : "/");

  // Not joined / still resolving — the community view is the right place to be.
  if (!community) return null;

  return createPortal(<HistoryAuditView community={community} onClose={close} />, document.body);
}
