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
  /** The event or rumor to serialize. */
  source: unknown;
  /**
   * What the reader is looking at. Required rather than defaulted because the
   * signed/unsigned distinction is the whole point of showing this, and it
   * differs per surface: a relay-read message carries its signature, a Concord
   * rumor never does.
   */
  description: string;
}

/**
 * The raw JSON behind a rendered row, with a copy button.
 *
 * Serialization happens only while `open`, and callers should ALSO gate the
 * mount — both, because these are rendered one per row on lists long enough
 * that stringifying every event on mount is pure cost, and a caller that
 * forgets the mount gate shouldn't pay it anyway.
 */
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
