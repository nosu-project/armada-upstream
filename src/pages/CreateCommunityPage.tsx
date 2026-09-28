import { createPortal } from "react-dom";

import { CreateCommunityWizard } from "@/concord/components/CreateCommunityWizard";
import { useBackOrHome } from "@/hooks/useBackOrHome";

/**
 * The community-creation wizard as a route, so closing the Add dialog that
 * opened it can't unmount it. Portalled to `<body>`: `WizardShell` is
 * `position: fixed` and a transformed ancestor would shrink it.
 */
export function CreateCommunityPage() {
  // A cold deep link has no history entry; falls back to the app root.
  const close = useBackOrHome();

  return createPortal(<CreateCommunityWizard onClose={close} />, document.body);
}
