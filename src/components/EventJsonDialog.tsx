import { Braces } from "lucide-react";
import { useMemo } from "react";

import { JsonBlock } from "@/components/JsonBlock";
import { ChromeDialogContent, ChromeDialogHeader, Dialog } from "@/components/ui/dialog";
import { useIntl } from "@/i18n";

interface EventJsonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: unknown;
  /** Required: signed vs. unsigned differs per surface (relay events vs. Concord rumors). */
  description: string;
}

/** Raw JSON behind a row, with copy. Serializes only while `open`; callers should also gate the mount. */
export function EventJsonDialog({ open, onOpenChange, source, description }: EventJsonDialogProps) {
  const intl = useIntl();
  const json = useMemo(() => (open ? JSON.stringify(source, null, 2) : ""), [open, source]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title={intl.formatMessage({ id: "eventJsonDialog.title", defaultMessage: "Event JSON" })} className="sm:max-w-2xl">
        <ChromeDialogHeader icon={Braces} title={intl.formatMessage({ id: "eventJsonDialog.header", defaultMessage: "event json" })} description={description} />
        <JsonBlock json={json} className="mt-5" />
      </ChromeDialogContent>
    </Dialog>
  );
}
