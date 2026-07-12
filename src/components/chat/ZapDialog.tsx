import { lazy, Suspense } from "react";

import { Dialog, DialogContent } from "@/components/ui/dialog";

import type { ChatMsg, OnchainZapAnnouncement, ZapPayment } from "@/components/chat/transport";

/**
 * Lazy shell for the zap dialog: the trigger (a toolbar button) renders with
 * zero cost, and the payment machinery (@getalby/sdk, bolt11 decoding, QR)
 * loads only when a dialog actually opens.
 */
const LazyZapDialogImpl = lazy(() => import("@/components/chat/ZapDialogImpl"));

export interface ZapDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ChatMsg;
  /** CORD.md lightning zap announcement publisher (Concord v2); absent = NIP-57. */
  sendZap?: (target: ChatMsg, payment: ZapPayment) => Promise<void>;
  /** CORD.md on-chain zap announcement publisher (Concord v2); absent = public kind 8333. */
  sendOnchainZap?: (target: ChatMsg, announcement: OnchainZapAnnouncement) => Promise<void>;
}

export function ZapDialog({ open, onOpenChange, target, sendZap, sendOnchainZap }: ZapDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose
        className="sm:max-w-[425px] rounded-2xl p-0 gap-0 overflow-hidden max-h-[95vh]"
        data-testid="zap-modal"
      >
        {open && (
          <Suspense fallback={<div className="h-64" />}>
            <LazyZapDialogImpl target={target} sendZap={sendZap} sendOnchainZap={sendOnchainZap} onDone={() => onOpenChange(false)} />
          </Suspense>
        )}
      </DialogContent>
    </Dialog>
  );
}
