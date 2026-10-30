import { Bitcoin, Check, Gem, Heart, Loader2, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Confetti } from "@/components/Confetti";
import { GenericPaymentContent } from "@/components/GenericPaymentContent";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useAppContext } from "@/hooks/useAppContext";
import { toast } from "@/hooks/useToast";
import { FormattedMessage, useIntl } from "@/i18n";
import { playFanfare } from "@/lib/fanfare";
import { PAYMENT_METHODS, type PaymentMethodDef, type PaymentTarget } from "@/lib/paymentTargets";

import type { ReactNode } from "react";

/** Soapbox's donation addresses. */
export const SOAPBOX_BITCOIN = "bc1q9cx35adpm73aq2fw40ye6ts8hfxqzjr5unwg0n";
export const SOAPBOX_MONERO = "45JDCLrjJ4bgVUSbbs2yjy9m5Mf4VLPW8fG7jw9sq5u69rXZZopQogZNeyYkMBnXpkaip4p4QwaaJNhdTotPa9g44DBCzdK";

/** How long the $0.00 "payment" pretends to process. */
const PROCESSING_MS = 1600;

type Step = "pitch" | "checkout" | "processing";

/** Settings › Armada Ultra: a free "subscription", then an optional donation to Soapbox. */
export function UltraSettings() {
  const intl = useIntl();
  const { config, updateConfig } = useAppContext();
  const since = config.armadaUltraSince;
  const [step, setStep] = useState<Step>("pitch");
  const [celebration, setCelebration] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const pay = () => {
    setStep("processing");
    // Made inside the click, or the autoplay policy keeps it suspended.
    let audio: AudioContext | undefined;
    try {
      audio = new AudioContext();
    } catch { /* no Web Audio: confetti only */ }
    if (audio) playFanfare(audio, PROCESSING_MS / 1000);
    timer.current = setTimeout(() => {
      updateConfig((c) => ({ ...c, armadaUltraSince: Date.now() }));
      setCelebration((n) => n + 1);
      setStep("pitch");
    }, PROCESSING_MS);
  };

  const cancel = () => {
    updateConfig((c) => ({ ...c, armadaUltraSince: undefined }));
    toast({
      title: intl.formatMessage({ id: "ultraSettings.cancelledTitle", defaultMessage: "Ultra cancelled" }),
      description: intl.formatMessage(
        { id: "ultraSettings.cancelledDescription", defaultMessage: "A refund of {amount} is on its way." },
        { amount: intl.formatNumber(0, { style: "currency", currency: "USD" }) },
      ),
    });
  };

  return (
    <>
      {celebration > 0 && <Confetti key={celebration} />}
      {since !== undefined ? (
        <UltraActive since={since} celebrating={celebration > 0} onCancel={cancel} />
      ) : step === "pitch" ? (
        <UltraPitch onContinue={() => setStep("checkout")} />
      ) : (
        <UltraCheckout processing={step === "processing"} onPay={pay} onBack={() => setStep("pitch")} />
      )}
    </>
  );
}

function UltraHero({ children }: { children: ReactNode }) {
  return (
    <div className="relative overflow-hidden clip-corner-lg bg-chrome px-6 py-8 text-center">
      <div aria-hidden className="absolute inset-0 bg-gradient-to-br from-primary/35 via-accent2/20 to-warning/20" />
      <div className="relative space-y-3">
        <span className="mx-auto flex size-16 items-center justify-center clip-corner-lg bg-gradient-to-br from-primary to-accent2 text-primary-foreground shadow-lg">
          <Gem className="size-8" />
        </span>
        {children}
      </div>
    </div>
  );
}

function UltraPitch({ onContinue }: { onContinue: () => void }) {
  const intl = useIntl();
  const perks = [
    intl.formatMessage({ id: "ultraSettings.perk.encryption", defaultMessage: "End-to-end encryption (you already had it)" }),
    intl.formatMessage({ id: "ultraSettings.perk.ads", defaultMessage: "Zero ads (there never were any)" }),
    intl.formatMessage({ id: "ultraSettings.perk.servers", defaultMessage: "Unlimited communities, with no servers to rent" }),
    intl.formatMessage({ id: "ultraSettings.perk.data", defaultMessage: "We still don't sell your data. We don't even have it." }),
    intl.formatMessage({ id: "ultraSettings.perk.uploads", defaultMessage: "Bigger uploads, as big as your Blossom server allows" }),
    intl.formatMessage({ id: "ultraSettings.perk.feeling", defaultMessage: "A warm, premium feeling" }),
  ];

  return (
    <>
      <UltraHero>
        <h3 className="text-2xl font-bold tracking-tight">Armada Ultra</h3>
        <p className="text-sm text-muted-foreground">
          <FormattedMessage id="ultraSettings.tagline" defaultMessage="Everything Armada already does, now for the low price of nothing." />
        </p>
      </UltraHero>
      <SettingsGroup title={intl.formatMessage({ id: "ultraSettings.perksTitle", defaultMessage: "What you get" })}>
        {perks.map((perk) => (
          <SettingsRow key={perk}>
            <span className="flex items-center gap-3 text-sm">
              <Sparkles className="size-4 shrink-0 text-primary" />
              {perk}
            </span>
          </SettingsRow>
        ))}
      </SettingsGroup>
      <div className="space-y-2">
        <Button className="w-full" size="lg" onClick={onContinue}>
          <Gem className="size-4 mr-2" />
          <FormattedMessage id="ultraSettings.getUltra" defaultMessage="Get Ultra for $0.00/month" />
        </Button>
        <p className="px-4 text-center text-xs text-muted-foreground">
          <FormattedMessage id="ultraSettings.noTrial" defaultMessage="No free trial, because it's free forever." />
        </p>
      </div>
    </>
  );
}

function UltraCheckout({ processing, onPay, onBack }: { processing: boolean; onPay: () => void; onBack: () => void }) {
  const intl = useIntl();
  const zero = intl.formatNumber(0, { style: "currency", currency: "USD" });
  const line = (label: string, value: string, strong?: boolean) => (
    <SettingsRow label={<span className={strong ? "font-semibold" : undefined}>{label}</span>} value={<span className={strong ? "font-semibold text-foreground" : undefined}>{value}</span>} />
  );

  return (
    <>
      <SettingsGroup
        title={intl.formatMessage({ id: "ultraSettings.orderTitle", defaultMessage: "Your order" })}
        footer={intl.formatMessage({ id: "ultraSettings.orderFooter", defaultMessage: "Cancel anytime. You'll get every cent back." })}
      >
        {line(intl.formatMessage({ id: "ultraSettings.orderItem", defaultMessage: "Armada Ultra, forever" }), zero)}
        {line(intl.formatMessage({ id: "ultraSettings.orderFees", defaultMessage: "Hidden fees" }), intl.formatMessage({ id: "ultraSettings.orderFeesValue", defaultMessage: "None, we checked" }))}
        {line(intl.formatMessage({ id: "ultraSettings.orderPayment", defaultMessage: "Payment method" }), intl.formatMessage({ id: "ultraSettings.orderPaymentValue", defaultMessage: "Not needed" }))}
        {line(intl.formatMessage({ id: "ultraSettings.orderTotal", defaultMessage: "Total" }), zero, true)}
      </SettingsGroup>
      <div className="space-y-2">
        <Button className="w-full" size="lg" onClick={onPay} disabled={processing}>
          {processing ? (
            <>
              <Loader2 className="size-4 mr-2 animate-spin" />
              <FormattedMessage id="ultraSettings.processing" defaultMessage="Processing your payment of {amount}…" values={{ amount: zero }} />
            </>
          ) : (
            <FormattedMessage id="ultraSettings.pay" defaultMessage="Pay {amount}" values={{ amount: zero }} />
          )}
        </Button>
        {!processing && (
          <Button variant="ghost" className="w-full" onClick={onBack}>
            <FormattedMessage id="ultraSettings.reconsider" defaultMessage="Let me think about it" />
          </Button>
        )}
      </div>
    </>
  );
}

type Coin = "bitcoin" | "monero";

const DONATION_METHODS: Record<Coin, { method: PaymentMethodDef; target: PaymentTarget }> = {
  bitcoin: {
    // The zap dialog draws Bitcoin itself, so its def has no URI; a donation wants the button.
    method: { ...PAYMENT_METHODS.bitcoin, uri: (a) => `bitcoin:${a}` },
    target: { type: "bitcoin", authority: SOAPBOX_BITCOIN },
  },
  monero: {
    method: PAYMENT_METHODS.monero,
    target: { type: "monero", authority: SOAPBOX_MONERO },
  },
};

function MoneroIcon({ className }: { className?: string }) {
  return <span aria-hidden className={className}>{PAYMENT_METHODS.monero.symbol}</span>;
}

function UltraActive({ since, celebrating, onCancel }: { since: number; celebrating: boolean; onCancel: () => void }) {
  const intl = useIntl();
  const [coin, setCoin] = useState<Coin>("bitcoin");
  const date = new Date(since).toLocaleDateString(intl.locale, { dateStyle: "long" });
  const donation = DONATION_METHODS[coin];

  return (
    <>
      <UltraHero>
        <h3 className="text-2xl font-bold tracking-tight">
          {celebrating
            ? <FormattedMessage id="ultraSettings.welcome" defaultMessage="Welcome to Ultra!" />
            : <FormattedMessage id="ultraSettings.activeTitle" defaultMessage="You're Ultra" />}
        </h3>
        <p className="text-sm text-muted-foreground">
          <FormattedMessage id="ultraSettings.activeBody" defaultMessage="Nothing has changed, and that's exactly how it should be. Thanks for being here." />
        </p>
      </UltraHero>

      <SettingsGroup title={intl.formatMessage({ id: "ultraSettings.membershipTitle", defaultMessage: "Membership" })}>
        <SettingsRow
          icon={Check}
          tone="success"
          label={intl.formatMessage({ id: "ultraSettings.status", defaultMessage: "Ultra is active" })}
          description={intl.formatMessage({ id: "ultraSettings.since", defaultMessage: "Since {date}" }, { date })}
        />
        <SettingsRow
          label={intl.formatMessage({ id: "ultraSettings.cancel", defaultMessage: "Cancel Ultra" })}
          destructive
          onClick={onCancel}
        />
      </SettingsGroup>

      <SettingsGroup
        id="ultra-support"
        title={intl.formatMessage({ id: "ultraSettings.supportTitle", defaultMessage: "Support Soapbox (totally optional)" })}
        footer={intl.formatMessage({
          id: "ultraSettings.supportFooter",
          defaultMessage: "Armada is free, open source software made by Soapbox and funded by grants and donations. If you really do want to pay for it, this is how.",
        })}
      >
        <SettingsRow>
          <div className="w-full space-y-1">
            <div className="flex items-center gap-2 pb-1 text-sm font-medium">
              <Heart className="size-4 text-destructive" />
              <FormattedMessage id="ultraSettings.donateLabel" defaultMessage="Donate to Soapbox" />
            </div>
            <PillTabs<Coin>
              labels="always"
              value={coin}
              onChange={setCoin}
              tabs={[
                { id: "bitcoin", label: PAYMENT_METHODS.bitcoin.label, icon: Bitcoin },
                { id: "monero", label: PAYMENT_METHODS.monero.label, icon: MoneroIcon },
              ]}
            />
            <GenericPaymentContent key={coin} method={donation.method} target={donation.target} />
          </div>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
