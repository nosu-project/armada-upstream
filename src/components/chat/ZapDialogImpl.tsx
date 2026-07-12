import { HelpCircle, Copy, ExternalLink, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { QRCodeCanvas } from "@/components/ui/qrcode";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAppContext } from "@/hooks/useAppContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { useToast } from "@/hooks/useToast";
import { useWallet } from "@/hooks/useWallet";
import { useZap } from "@/hooks/useZap";
import { writeClipboardText } from "@/lib/clipboard";
import { ZAP_PRESETS, formatSats } from "@/lib/zaps";

import type { ChatMsg, ZapPayment } from "@/components/chat/transport";

interface ZapDialogImplProps {
  target: ChatMsg;
  sendZap?: (target: ChatMsg, payment: ZapPayment) => Promise<void>;
  onDone: () => void;
}

const PRESETS = ZAP_PRESETS.slice(0, 5);

/** The zap dialog body — a faithful port of ditto's Lightning tab. */
export default function ZapDialogImpl({ target, sendZap, onDone }: ZapDialogImplProps) {
  const { config } = useAppContext();
  const { toast } = useToast();
  const { webln } = useWallet();
  const author = useAuthor(target.pubkey);
  const metadata = author.data?.metadata;
  const displayName = useScopedDisplayName(target.pubkey, metadata);

  const [amount, setAmount] = useState<number>(config.defaultZapAmount || PRESETS[1]);
  const [editingAmount, setEditingAmount] = useState(false);
  const [error, setError] = useState("");
  const amountInputRef = useRef<HTMLInputElement>(null);

  const { zap, status, invoice } = useZap({
    target,
    recipient: { pubkey: target.pubkey, metadata },
    sendZap,
  });

  const isPrivate = Boolean(sendZap);
  const busy = status === "resolving" || status === "paying";

  useEffect(() => {
    if (editingAmount) {
      amountInputRef.current?.focus();
      amountInputRef.current?.select();
    }
  }, [editingAmount]);

  const commitAmountEdit = useCallback(() => {
    setEditingAmount(false);
  }, []);

  const handleZap = async () => {
    setError("");
    if (amount <= 0) { setError("Enter an amount."); return; }
    try {
      const outcome = await zap(amount, "");
      if (outcome === "paid") {
        toast({ title: `Zapped ${formatSats(amount)} sats ⚡` });
        onDone();
      } else if (outcome === "unproven") {
        toast({
          title: `Sent ${formatSats(amount)} sats ⚡`,
          description:
            "The payment went through, but this wallet can't provide the proof needed to show a private zap tally here. Use a wallet like Alby Hub, Coinos, or lnbits to have private zaps counted.",
        });
        onDone();
      }
    } catch (e) {
      toast({
        title: "Zap failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  };

  const handleCopy = () => {
    if (invoice) {
      void writeClipboardText(invoice);
      toast({ title: "Invoice copied" });
    }
  };

  const openInWallet = () => {
    if (invoice) {
      window.location.href = `lightning:${invoice}`;
    }
  };

  const showingInvoice = status === "manual" && invoice;

  return (
    <>
      <div className="flex items-center justify-between px-4 h-12">
        <DialogTitle className="text-base font-semibold flex items-center gap-1.5 min-w-0">
          <span className="truncate">
            {showingInvoice ? "Lightning Payment" : isPrivate ? "Private Zap" : `Zap ${displayName}`}
          </span>
          {isPrivate && !showingInvoice && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="How private zaps work"
                >
                  <HelpCircle className="size-4 shrink-0" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" side="bottom" className="w-72 p-3 text-xs leading-relaxed text-foreground/80">
                Payment proof (preimage) is sealed into the channel so members verify the zap locally. No public receipt, no relay tally.
              </PopoverContent>
            </Popover>
          )}
        </DialogTitle>
        <button
          type="button"
          onClick={onDone}
          className="p-1.5 -mr-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
          aria-label="Close"
        >
          <X className="size-5" />
        </button>
      </div>

      <div className="overflow-y-auto max-h-[calc(95vh-3rem)]">
        {showingInvoice ? (
          <div className="grid gap-3 px-4 py-4 w-full overflow-hidden">
            <div className="flex flex-col items-center pt-1">
              <div className="text-3xl font-semibold tabular-nums">
                {formatSats(amount)} sats
              </div>
            </div>

            <div className="flex justify-center">
              <div className="bg-white p-3 rounded-xl" aria-label="Lightning invoice QR code">
                <QRCodeCanvas value={invoice!.toUpperCase()} size={220} level="M" className="block" />
              </div>
            </div>

            <div className="flex gap-2 min-w-0">
              <Input
                value={invoice!}
                readOnly
                aria-label="Lightning invoice"
                className="font-mono text-xs min-w-0 flex-1 overflow-hidden text-ellipsis"
                onClick={(e) => e.currentTarget.select()}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={handleCopy}
                className="shrink-0"
                aria-label="Copy invoice"
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>

            <div className="grid gap-2">
              {webln && (
                <Button type="button" onClick={handleZap} disabled={busy} className="w-full">
                  {busy ? (
                    <>
                      <Loader2 className="size-4 mr-1.5 animate-spin" />
                      Processing…
                    </>
                  ) : (
                    "Pay with WebLN"
                  )}
                </Button>
              )}
              <Button
                type="button"
                variant={webln ? "outline" : "default"}
                onClick={openInWallet}
                className="w-full"
              >
                <ExternalLink className="h-4 w-4 mr-2" />
                Open in Lightning Wallet
              </Button>
            </div>

            <p className="text-[11px] text-muted-foreground text-center">
              Scan the QR or copy the invoice to pay with any Lightning wallet.
            </p>
          </div>
        ) : (
          <div className="grid gap-3 px-4 py-4 w-full overflow-hidden">
            <div className="flex flex-col items-center pt-2">
              {editingAmount ? (
                <div className="flex items-baseline justify-center">
                  <input
                    ref={amountInputRef}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={amount || ""}
                    onChange={(e) => { setAmount(Number(e.target.value)); setError(""); }}
                    onBlur={commitAmountEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); commitAmountEdit(); }
                    }}
                    aria-label="Amount in sats"
                    className="bg-transparent border-0 outline-none text-4xl font-semibold text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    style={{ width: `${Math.max(2, String(amount).length + 1)}ch` }}
                  />
                  <span className="text-4xl font-semibold text-muted-foreground"> sats</span>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setEditingAmount(true)}
                  aria-label="Edit amount"
                  className="flex items-baseline justify-center rounded-md px-2 -mx-2 hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
                >
                  <span className="text-4xl font-semibold tabular-nums">
                    {formatSats(amount)}
                  </span>
                  <span className="text-4xl font-semibold text-muted-foreground"> sats</span>
                </button>
              )}
            </div>

            <ToggleGroup
              type="single"
              value={PRESETS.includes(amount) ? String(amount) : ""}
              onValueChange={(v) => { if (v) { setAmount(Number(v)); setError(""); setEditingAmount(false); } }}
              className="grid grid-cols-5 gap-1 w-full"
            >
              {PRESETS.map((preset) => (
                <ToggleGroupItem
                  key={preset}
                  value={String(preset)}
                  className="h-8 min-w-0 text-xs font-semibold px-1"
                >
                  {formatSats(preset)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <Button
              type="button"
              onClick={handleZap}
              disabled={busy || amount <= 0}
              className="w-full"
            >
              {busy ? (
                <>
                  <Loader2 className="size-4 mr-1.5 animate-spin" />
                  {status === "resolving" ? "Creating invoice…" : "Paying…"}
                </>
              ) : (
                `Send ${formatSats(amount)} sats`
              )}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
