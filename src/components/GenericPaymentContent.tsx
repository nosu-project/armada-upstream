import { useMemo, useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { QRCodeCanvas } from '@/components/ui/qrcode';
import { useToast } from '@/hooks/useToast';
import { FormattedMessage, common, t, useIntl } from '@/i18n';
import { openUrl } from '@/lib/share';
import { type PaymentMethodDef, type PaymentTarget } from '@/lib/paymentTargets';

interface GenericPaymentContentProps {
  method: PaymentMethodDef;
  target: PaymentTarget;
}

/** Non-native payment method (Monero, Ethereum, Cash App, …): QR, address and native-URI button. Never `payto:`. */
export function GenericPaymentContent({ method, target }: GenericPaymentContentProps) {
  const { toast } = useToast();
  const intl = useIntl();
  const [copied, setCopied] = useState(false);

  const uri = useMemo(() => method.uri(target.authority), [method, target.authority]);
  const qrValue = uri ?? target.authority;

  const displayAddress = useMemo(() => {
    const addr = target.authority;
    return addr.length > 24 ? `${addr.slice(0, 12)}...${addr.slice(-8)}` : addr;
  }, [target.authority]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(target.authority);
      setCopied(true);
      toast({
        title: t(common.copied),
        description: t({ id: 'genericPaymentContent.copiedDescription', defaultMessage: '{method} address copied to clipboard' }, { method: method.label }),
      });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: t({ id: 'genericPaymentContent.copyFailed', defaultMessage: 'Copy failed' }),
        description: t({ id: 'genericPaymentContent.copyManually', defaultMessage: 'Please copy manually.' }),
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="grid gap-3 px-4 py-4 w-full overflow-hidden">
      <div className="flex justify-center">
        <div className="bg-white p-3 rounded-xl" aria-label={intl.formatMessage({ id: 'genericPaymentContent.qrLabel', defaultMessage: '{method} payment QR code' }, { method: method.label })}>
          <QRCodeCanvas value={qrValue} size={220} level="M" className="block" />
        </div>
      </div>

      <div className="flex justify-center">
        <button
          type="button"
          onClick={handleCopy}
          title={target.authority}
          aria-label={intl.formatMessage({ id: 'genericPaymentContent.copyAddress', defaultMessage: 'Copy {method} address' }, { method: method.label })}
          className="flex items-center gap-2 clip-corner-lg bg-secondary px-4 py-2 touch:min-h-11 text-sm font-mono text-muted-foreground hover:bg-secondary/80 hover:text-foreground transition-colors cursor-pointer max-w-full"
        >
          <span className="truncate">{displayAddress}</span>
          {copied ? (
            <Check className="size-3.5 shrink-0 text-green-500" />
          ) : (
            <Copy className="size-3.5 shrink-0" />
          )}
        </button>
      </div>

      {uri && (
        <Button type="button" onClick={() => openUrl(uri)} className="w-full">
          <ExternalLink className="h-4 w-4 mr-2" />
          <FormattedMessage id="genericPaymentContent.openIn" defaultMessage="Open in {method}" values={{ method: method.label }} />
        </Button>
      )}
    </div>
  );
}
