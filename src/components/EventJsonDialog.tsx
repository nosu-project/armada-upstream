import { Braces } from "lucide-react";
import { useMemo } from "react";

import { JsonBlock } from "@/components/JsonBlock";
import { ChromeDialogContent, ChromeDialogHeader, Dialog } from "@/components/ui/dialog";

interface EventJsonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: unknown;
  /** Required: signed vs. unsigned differs per surface (relay events vs. Concord rumors). */
  description: string;
}

/** Raw JSON behind a row, with copy. Serializes only while `open`; callers should also gate the mount. */
export function EventJsonDialog({ open, onOpenChange, source, description }: EventJsonDialogProps) {
  const json = useMemo(() => (open ? JSON.stringify(source, null, 2) : ""), [open, source]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title="Event JSON" className="sm:max-w-2xl">
        <ChromeDialogHeader icon={Braces} title="event json" description={description} />
        <JsonBlock json={json} className="mt-5" />
      </ChromeDialogContent>
    </Dialog>
  );
}
