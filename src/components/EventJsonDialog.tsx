import { useMemo } from "react";

import { JsonBlock } from "@/components/JsonBlock";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Event JSON</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <JsonBlock json={json} />
      </DialogContent>
    </Dialog>
  );
}
