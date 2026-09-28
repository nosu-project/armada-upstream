import { Copy } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { writeClipboardText } from "@/lib/clipboard";

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
        <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
          {json}
        </pre>
        <div className="flex justify-end">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => writeClipboardText(json).catch(() => undefined)}
          >
            <Copy className="mr-2 size-4" /> Copy JSON
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
