import { lazy, Suspense } from "react";

import { Dialog, DialogContent } from "@/components/ui/dialog";

import type { ChatMsg, OnchainZapAnnouncement, ZapPayment } from "@/components/chat/transport";

/** Lazy shell: payment machinery (@getalby/sdk, bolt11, QR) loads only when a dialog opens. */
const LazyZapDialogImpl = lazy(() => import("@/components/chat/ZapDialogImpl"));

export interface ZapDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ChatMsg;
  /** CORD.md lightning zap announcement publisher (Concord); absent = NIP-57. */
  sendZap?: (target: ChatMsg, payment: ZapPayment) => Promise<void>;
  /** CORD.md on-chain zap announcement publisher (Concord); absent = public kind 8333. */
  sendOnchainZap?: (target: ChatMsg, announcement: OnchainZapAnnouncement) => Promise<void>;
}

export function ZapDialog({ open, onOpenChange, target, sendZap, sendOnchainZap }: ZapDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose
        className="sm:max-w-[425px] border-0 rounded-[0.55rem] clip-corner-lg bg-chrome shadow-none p-0 gap-0 overflow-hidden max-h-[95vh]"
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
