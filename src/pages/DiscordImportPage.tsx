import { createPortal } from "react-dom";

import { DiscordImportWizard } from "@/components/discord-import/DiscordImportWizard";
import { useBackOrHome } from "@/hooks/useBackOrHome";

/**
 * The Discord import wizard, as a route.
 *
 * It is a route rather than something a button renders because the flow
 * outlives whatever opened it. The entry points sit inside the Add dialog and
 * the Discover tile; when opening the wizard dismissed that dialog, the button
 * unmounted with it and took the wizard's state — and the wizard — down at the
 * same instant. Owning it here means nothing below can unmount it, and the
 * dialog disappears on its own because the route changed.
 *
 * Portalled to `<body>` on top of that: `WizardShell` is `position: fixed`, and
 * any transformed ancestor would become its containing block and shrink it to
 * that element's box instead of the screen.
 */
export function DiscordImportPage() {
  // Leaving the wizard goes back where they came from. A cold deep link has no
  // entry to return to, so it falls through to the app root instead of exiting.
  const close = useBackOrHome();

  return createPortal(<DiscordImportWizard onClose={close} />, document.body);
}
