import { useEffect } from "react";

import { ToastAction } from "@/components/ui/toast";
import { toast } from "@/hooks/useToast";
import { onDesktopWebUpdateReady, restartForDesktopWebUpdate } from "@/lib/desktop";

/** In-app "restart to update" notice for a web bundle the desktop shell installed. */
export function DesktopUpdateToast() {
  useEffect(
    () =>
      onDesktopWebUpdateReady(() => {
        toast({
          title: "Update available",
          description: "Restart Armada to use the new version.",
          duration: Infinity,
          action: (
            <ToastAction altText="Restart Armada to update" onClick={restartForDesktopWebUpdate}>
              Restart
            </ToastAction>
          ),
        });
      }),
    [],
  );

  return null;
}
