import { ChevronDown, Copy, ExternalLink, HelpCircle, Loader2, MessageCircle, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { AmountField } from "@/components/AmountField";
import { DisplayName } from "@/components/DisplayName";
import { OnchainZapContent } from "@/components/OnchainZapContent";
import { GenericPaymentContent } from "@/components/GenericPaymentContent";
import { PaymentMethodIcon } from "@/components/PaymentMethodIcon";
import { ZapSuccessScreen } from "@/components/ZapSuccessScreen";
import { Button } from "@/components/ui/button";
import {
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { QRCodeCanvas } from "@/components/ui/qrcode";
import { useAppContext } from "@/hooks/useAppContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useBitcoinSigner } from "@/hooks/useBitcoinSigner";
import { useEsploraApis } from "@/hooks/useEsploraApis";
import { usePaymentTargets } from "@/hooks/usePaymentTargets";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { useToast } from "@/hooks/useToast";
import { useWallet } from "@/hooks/useWallet";
import { useZap } from "@/hooks/useZap";
import { canZap } from "@/lib/canZap";
import { pickDefaultZapMethod } from "@/components/chat/zapDefaultMethod";
import { writeClipboardText } from "@/lib/clipboard";
import {
  amountInputToSats,
  fetchBtcPrice,
  formatAmountInput,
  formatMoneyAmount,
  formatSatsAmount,
  isLargeAmount,
  type AmountPresetSet,
} from "@/lib/bitcoinMoney";
import {
  PAYMENT_METHODS,
  findBitcoinTarget,
  findLightningTarget,
  isSilentPaymentLike,
  type PaymentMethodDef,
  type PaymentTarget,
} from "@/lib/paymentTargets";

import type { ChatMsg, OnchainZapAnnouncement, ZapPayment } from "@/components/chat/transport";
import type { CurrencyDisplay } from "@/contexts/AppContext";

interface ZapDialogImplProps {
  target: ChatMsg;
  sendZap?: (target: ChatMsg, payment: ZapPayment) => Promise<void>;
  sendOnchainZap?: (target: ChatMsg, announcement: OnchainZapAnnouncement) => Promise<void>;
  onDone: () => void;
}

/**
 * Amount presets for the Lightning pane. Lightning zaps are expected to be
 * much smaller than on-chain sends (which have a fixed per-tx fee floor), so
 * the presets stay in tip-jar territory. The sats row is hand-picked round
 * numbers rather than a conversion of the USD row.
 */
const LIGHTNING_PRESETS: AmountPresetSet = {
  usd: [0.1, 0.5, 1, 2, 5],
  sats: [100, 500, 1_000, 2_100, 5_000],
};

/** Opening amount for a fresh dialog, in the user's display currency. */
function defaultAmount(currency: CurrencyDisplay): number {
  return currency === "sats" ? 500 : 0.5;
}

type DialogMethodId = string;

interface DialogMethod {
  id: DialogMethodId;
  def: PaymentMethodDef;
  target?: PaymentTarget;
}

function methodTitle(method: DialogMethod | undefined): string {
  if (!method) return "Send Bitcoin";
  if (method.def.kind === "bitcoin") return "Send Bitcoin";
  return method.def.label;
}

/** The zap dialog body — method switcher + Lightning/Bitcoin/generic panes. */
export default function ZapDialogImpl({ target, sendZap, sendOnchainZap, onDone }: ZapDialogImplProps) {
  const { config } = useAppContext();
  const { toast } = useToast();
  const { activeConnection, webln } = useWallet();
  const author = useAuthor(target.pubkey);
  const metadata = author.data?.metadata;
  const displayName = useScopedDisplayName(target.pubkey, metadata);

  const isPrivate = Boolean(sendZap);
  // A private zap's tally is proven by the payment preimage, which only a
  // connected wallet (NWC / WebLN) can return — the manual QR path can't, so
  // without a wallet the pane blocks instead of offering a payment that could
  // never be counted (matching the original feat/zaps design).
  const walletRequired = isPrivate && !activeConnection && !webln;
  const hasLightning = canZap(metadata);

  // NIP-A3 payment targets. Only fetch once the dialog is open (the parent
  // already gates the mount on `open`).
  const { targets: paymentTargets } = usePaymentTargets(target.pubkey);
  const lightningTarget = useMemo(() => findLightningTarget(paymentTargets), [paymentTargets]);
  const bitcoinTarget = useMemo(() => findBitcoinTarget(paymentTargets), [paymentTargets]);
  const bitcoinOverride = useMemo(
    () =>
      bitcoinTarget
        ? {
            value: bitcoinTarget.authority,
            mode: isSilentPaymentLike(bitcoinTarget.authority) ? ("sp" as const) : ("onchain" as const),
          }
        : undefined,
    [bitcoinTarget],
  );

  const genericTargets = useMemo(
    () => paymentTargets.filter((t) => t.type !== "bitcoin" && t.type !== "lightning"),
    [paymentTargets],
  );

  // Bitcoin capability probe — determines whether the on-chain pane is
  // usable or falls back to the unsupported-signer QR view.
  const { capability: btcCapability } = useBitcoinSigner();
  const bitcoinUnsupported = btcCapability === "unsupported";

  // Build the ordered method list.
  const methods = useMemo<DialogMethod[]>(() => {
    const list: DialogMethod[] = [{ id: "bitcoin", def: PAYMENT_METHODS.bitcoin }];
    if (hasLightning || lightningTarget) {
      list.push({ id: "lightning", def: PAYMENT_METHODS.lightning });
    }
    for (const t of genericTargets) {
      list.push({ id: t.type, def: PAYMENT_METHODS[t.type], target: t });
    }
    return list;
  }, [hasLightning, lightningTarget, genericTargets]);

  // Determine the default method: the user's preference, unless it can't be
  // completed here — a private zap's Lightning pane with no connected wallet is
  // a dead end, so the dialog must open on a method that actually works or it
  // looks like there are no payment options at all.
  const defaultMethodId: DialogMethodId = pickDefaultZapMethod({
    preferred: config.defaultZapMethod,
    available: methods.map((m) => m.id),
    lightningAvailable: hasLightning || Boolean(lightningTarget),
    walletRequired,
    bitcoinUnsupported,
  });
  const [activeMethod, setActiveMethod] = useState<DialogMethodId>(defaultMethodId);
  const currentMethod = methods.find((m) => m.id === activeMethod) ?? methods[0];

  // Success state — replaces the method UI when set.
  const [success, setSuccess] = useState<
    | { kind: "onchain"; amountSats: number; txid: string }
    | { kind: "lightning"; amountSats: number }
    | null
  >(null);

  const esploraApis = useEsploraApis();
  const { data: btcPrice } = useQuery({
    queryKey: ["btc-price", esploraApis],
    queryFn: ({ signal }) => fetchBtcPrice(esploraApis, signal),
    staleTime: 30_000,
  });

  // ── Lightning state ──
  // The amount is denominated in the user's display currency (matching the
  // Bitcoin pane) and converted to sats just before the LNURL call.
  const currency: CurrencyDisplay = config.currencyDisplay ?? "usd";
  const [amount, setAmount] = useState<number | string>(() => defaultAmount(currency));
  const [comment, setComment] = useState("");
  const [showComment, setShowComment] = useState(false);
  const [editingAmount, setEditingAmount] = useState(false);
  const [error, setError] = useState("");
  const [confirmArmed, setConfirmArmed] = useState(false);

  const amountSats = useMemo(
    () => amountInputToSats(amount, currency, btcPrice),
    [amount, currency, btcPrice],
  );
  const isLarge = isLargeAmount(amountSats, btcPrice);
  // In USD mode `amountSats` is 0 until the BTC price lands, so fall back to
  // echoing the raw input ("$0.10") rather than rendering an empty label.
  const amountDisplay = amountSats > 0
    ? formatMoneyAmount(amountSats, currency, btcPrice)
    : formatAmountInput(amount, currency);

  const { zap, status, invoice } = useZap({
    target,
    recipient: { pubkey: target.pubkey, metadata },
    lnAddressOverride: lightningTarget?.authority,
    sendZap,
  });

  const busy = status === "resolving" || status === "paying";
  const showingInvoice = status === "manual" && invoice;

  // Re-arm (clear confirmation) whenever the amount moves — editing after
  // arming forces another deliberate click. Mirrors OnchainZapContent.
  useEffect(() => {
    setConfirmArmed(false);
  }, [amountSats]);

  const handleLightningZap = async () => {
    setError("");
    // Only USD input needs a price to become sats; a sats amount is payable
    // as-is even when the price endpoint is down.
    if (currency === "usd" && !btcPrice) { setError("Waiting for BTC price…"); return; }
    if (amountSats <= 0) { setError("Enter an amount."); return; }

    // Two-tap safety for large amounts: first click arms, second click sends.
    if (isLarge && !confirmArmed) {
      setConfirmArmed(true);
      return;
    }

    try {
      const outcome = await zap(amountSats, comment.trim());
      if (outcome === "paid") {
        setSuccess({ kind: "lightning", amountSats });
      } else if (outcome === "unproven") {
        toast({
          title: `Sent ${formatSatsAmount(amountSats)} ⚡`,
          description:
            "The payment went through, but the wallet hasn't provided the proof a private zap tally needs. We'll keep checking for a couple of minutes and count the zap if it turns up — wallets like Alby Hub, Coinos, or lnbits provide it reliably.",
        });
        setSuccess({ kind: "lightning", amountSats });
      }
      // "manual" keeps the dialog open — the QR view renders below.
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
    if (invoice) window.location.href = `lightning:${invoice}`;
  };

  return (
    <>
      <div className="flex items-center justify-between px-4 h-12">
        <DialogTitle className="text-base font-semibold flex items-center gap-1.5 min-w-0">
          {success ? (
            "Success"
          ) : showingInvoice ? (
            "Lightning Payment"
          ) : methods.length > 1 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 min-w-0 rounded-md px-1 -mx-1 hover:bg-secondary/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
                  aria-label="Switch payment method"
                >
                  <PaymentMethodIcon method={currentMethod?.def} />
                  <span className="truncate">{methodTitle(currentMethod)}</span>
                  <ChevronDown className="size-4 shrink-0 opacity-70" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-44" onClick={(e) => e.stopPropagation()}>
                {methods.map((m) => (
                  <DropdownMenuItem
                    key={m.id}
                    onSelect={() => setActiveMethod(m.id)}
                    className="gap-2"
                  >
                    <PaymentMethodIcon method={m.def} />
                    <span>{m.def.label}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span className="truncate">
              {isPrivate ? (
                "Private Zap"
              ) : (
                <>Zap <DisplayName pubkey={target.pubkey} name={displayName} /></>
              )}
            </span>
          )}
          {isPrivate && !showingInvoice && !success && (
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
        {success ? (
          <ZapSuccessScreen
            recipientPubkey={target.pubkey}
            amountSats={success.amountSats}
            btcPrice={btcPrice}
            txid={success.kind === "onchain" ? success.txid : undefined}
            onClose={onDone}
          />
        ) : showingInvoice ? (
          <LightningInvoiceView
            invoice={invoice!}
            amountDisplay={amountDisplay}
            webln={!!webln}
            busy={busy}
            onPay={handleLightningZap}
            onCopy={handleCopy}
            onOpenInWallet={openInWallet}
          />
        ) : currentMethod?.def.kind === "lightning" ? (
          <LightningZapPane
            amount={amount}
            setAmount={setAmount}
            currency={currency}
            amountSats={amountSats}
            amountDisplay={amountDisplay}
            isLarge={isLarge}
            confirmArmed={confirmArmed}
            comment={comment}
            setComment={setComment}
            showComment={showComment}
            setShowComment={setShowComment}
            editingAmount={editingAmount}
            setEditingAmount={setEditingAmount}
            error={error}
            setError={setError}
            busy={busy}
            status={status}
            walletRequired={walletRequired}
            onZap={handleLightningZap}
          />
        ) : currentMethod?.def.kind === "generic" && currentMethod.target ? (
          <GenericPaymentContent method={currentMethod.def} target={currentMethod.target} />
        ) : (
          // Default: native Bitcoin
          <OnchainZapContent
            target={target}
            bitcoinTarget={bitcoinOverride}
            sendOnchainZap={sendOnchainZap}
            onSuccess={({ txid, amountSats }) => setSuccess({ kind: "onchain", amountSats, txid })}
            onClose={onDone}
          />
        )}
      </div>
    </>
  );
}

// ── Lightning pane (amount + presets + send) ──────────────────────────────

interface LightningZapPaneProps {
  /** Raw amount input, denominated in `currency`. */
  amount: number | string;
  setAmount: (v: number | string) => void;
  currency: CurrencyDisplay;
  amountSats: number;
  /** The amount rendered in the display currency, for the send button. */
  amountDisplay: string;
  isLarge: boolean;
  confirmArmed: boolean;
  comment: string;
  setComment: (v: string) => void;
  showComment: boolean;
  setShowComment: (v: boolean) => void;
  editingAmount: boolean;
  setEditingAmount: (v: boolean) => void;
  error: string;
  setError: (s: string) => void;
  busy: boolean;
  status: string;
  /** Private zap with no connected wallet: block the CTA (no provable payment). */
  walletRequired: boolean;
  onZap: () => void;
}

function LightningZapPane({
  amount,
  setAmount,
  currency,
  amountSats,
  amountDisplay,
  isLarge,
  confirmArmed,
  comment,
  setComment,
  showComment,
  setShowComment,
  editingAmount,
  setEditingAmount,
  error,
  setError,
  busy,
  status,
  walletRequired,
  onZap,
}: LightningZapPaneProps) {
  return (
    <div className="grid gap-3 px-4 py-4 w-full overflow-hidden">
      {/* Amount — big number on top, editable by clicking, plus preset chips.
          Lightning zaps lean small, so the defaults stay in tip-jar territory. */}
      <div className="grid gap-3 pt-2">
        <AmountField
          value={amount}
          onValueChange={(v) => { setAmount(v); setError(""); }}
          currency={currency}
          editing={editingAmount}
          setEditing={setEditingAmount}
          presets={LIGHTNING_PRESETS}
        />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {walletRequired && (
        <p className="text-xs text-amber-500">
          Private zaps need a payment proof, so connect a wallet (Settings → Wallet) — or
          switch to Bitcoin or another method from the menu above.
        </p>
      )}

      {/* Optional comment — carried into the NIP-57 zap request, or sealed into
          the private announcement. Revealed by the icon on the Send row so it
          costs no space until wanted. */}
      {showComment && (
        <Input
          type="text"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Add a comment (optional)"
          maxLength={280}
          aria-label="Comment"
          autoFocus
          className="text-sm rounded-full motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2 motion-safe:duration-200"
        />
      )}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          onClick={onZap}
          disabled={busy || amountSats <= 0 || walletRequired}
          variant={isLarge && !busy ? "destructive" : "default"}
          className="flex-1 rounded-full"
        >
          {busy ? (
            <>
              <Loader2 className="size-4 mr-1.5 animate-spin" />
              {status === "resolving" ? "Creating invoice…" : "Paying…"}
            </>
          ) : isLarge && confirmArmed ? (
            <>Tap again to send {amountDisplay}</>
          ) : (
            <>Send {amountDisplay}</>
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setShowComment(!showComment)}
          aria-label="Add a comment"
          aria-pressed={showComment}
          className={`rounded-full ${comment.trim() ? "text-primary" : "text-muted-foreground"}`}
        >
          <MessageCircle className="size-4" />
        </Button>
      </div>
    </div>
  );
}

// ── Lightning invoice (QR) view ───────────────────────────────────────────

interface LightningInvoiceViewProps {
  invoice: string;
  /** The amount rendered in the user's display currency. */
  amountDisplay: string;
  webln: boolean;
  busy: boolean;
  onPay: () => void;
  onCopy: () => void;
  onOpenInWallet: () => void;
}

function LightningInvoiceView({
  invoice,
  amountDisplay,
  webln,
  busy,
  onPay,
  onCopy,
  onOpenInWallet,
}: LightningInvoiceViewProps) {
  return (
    <div className="grid gap-3 px-4 py-4 w-full overflow-hidden">
      <div className="flex flex-col items-center pt-1">
        <div className="text-3xl font-semibold tabular-nums">
          {amountDisplay}
        </div>
      </div>

      <div className="flex justify-center">
        <div className="bg-white p-3 rounded-xl" aria-label="Lightning invoice QR code">
          <QRCodeCanvas value={invoice.toUpperCase()} size={220} level="M" className="block" />
        </div>
      </div>

      <div className="flex gap-2 min-w-0">
        <Input
          value={invoice}
          readOnly
          aria-label="Lightning invoice"
          className="font-mono text-xs min-w-0 flex-1 overflow-hidden text-ellipsis"
          onClick={(e) => e.currentTarget.select()}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={onCopy}
          className="shrink-0"
          aria-label="Copy invoice"
        >
          <Copy className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid gap-2">
        {webln && (
          <Button type="button" onClick={onPay} disabled={busy} className="w-full">
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
          onClick={onOpenInWallet}
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
  );
}
