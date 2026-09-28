import { createPortal } from "react-dom";

import { DiscordImportWizard } from "@/components/discord-import/DiscordImportWizard";
import { useBackOrHome } from "@/hooks/useBackOrHome";

/**
 * The Discord import wizard as a route, so closing the Add dialog that opened it
 * can't unmount it. Portalled to `<body>`: `WizardShell` is `position: fixed`
 * and a transformed ancestor would shrink it.
 */
export function DiscordImportPage() {
  // A cold deep link has no history entry; falls back to the app root.
  const close = useBackOrHome();

  return createPortal(<DiscordImportWizard onClose={close} />, document.body);
}
