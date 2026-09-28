import { Bitcoin, Zap } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { PaymentMethodDef } from '@/lib/paymentTargets';

interface PaymentMethodIconProps {
  method: PaymentMethodDef | undefined;
  className?: string;
}

/** NIP-A3 payment method icon: lucide glyphs for Bitcoin/Lightning, currency symbol otherwise. */
export function PaymentMethodIcon({ method, className }: PaymentMethodIconProps) {
  const cls = cn('size-4 shrink-0', className);
  if (!method || method.kind === 'bitcoin') return <Bitcoin className={cls} />;
  if (method.kind === 'lightning') return <Zap className={cls} />;
  return (
    <span aria-hidden className={cn('w-4 text-center shrink-0 text-base leading-none', className)}>
      {method.symbol}
    </span>
  );
}
