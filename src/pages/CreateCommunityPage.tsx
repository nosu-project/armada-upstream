import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";

import { CreateCommunityWizard } from "@/concord/components/CreateCommunityWizard";

/**
 * The community-creation wizard, as a route.
 *
 * A route rather than something a button renders, for the reason
 * {@link DiscordImportPage} is: the entry points sit inside the Add dialog and
 * the Discover tile, and opening the wizard dismisses that dialog — which would
 * unmount the button, and with it the wizard and everything typed into it.
 * Owning it here means nothing below can take it down, and the dialog closes on
 * its own because the route changed.
 *
 * Portalled to `<body>` for the same reason too: `WizardShell` is
 * `position: fixed`, so any transformed ancestor would become its containing
 * block and shrink it to that element's box instead of the screen.
 */
export function CreateCommunityPage() {
  const navigate = useNavigate();

  // Leaving the wizard goes back where they came from. A cold deep link has no
  // entry to return to, so it falls through to the app root instead of exiting.
  const close = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate("/", { replace: true });
  };

  return createPortal(<CreateCommunityWizard onClose={close} />, document.body);
}
