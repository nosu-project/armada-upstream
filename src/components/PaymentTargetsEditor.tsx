import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PaymentMethodIcon } from '@/components/PaymentMethodIcon';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { usePaymentTargets, useUpdatePaymentTargets } from '@/hooks/usePaymentTargets';
import { useToast } from '@/hooks/useToast';
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LIST,
  type PaymentTarget,
  type PaymentTargetType,
} from '@/lib/paymentTargets';

interface DraftTarget {
  key: string;
  type: PaymentTargetType;
  authority: string;
}

let draftSeq = 0;
function newDraft(type: PaymentTargetType, authority = ''): DraftTarget {
  return { key: `pt-${draftSeq++}`, type, authority };
}

export interface PaymentTargetsEditorHandle {
  /** Validate and publish kind 10133. `false` on validation/publish failure; toasts its own errors. */
  save: () => Promise<boolean>;
}

/**
 * "Accept Donations" editor for NIP-A3 payment targets (kind 10133), one per
 * method. Bitcoin/Lightning entries override the pubkey-derived Taproot
 * address and kind-0 `lud16`. Saved via the parent form through the handle.
 */
export const PaymentTargetsEditor = forwardRef<PaymentTargetsEditorHandle>(
  function PaymentTargetsEditor(_props, ref) {
    const { user } = useCurrentUser();
    const { toast } = useToast();
    const { targets, isLoading } = usePaymentTargets(user?.pubkey);
    const { mutateAsync: updateTargets } = useUpdatePaymentTargets();

    const [drafts, setDrafts] = useState<DraftTarget[]>([]);

    // Reset only when the stored set changes identity, not per keystroke.
    const seed = useMemo(
      () => targets.map((t) => newDraft(t.type, t.authority)),
      [targets],
    );
    useEffect(() => {
      setDrafts(seed);
    }, [seed]);

    const usedTypes = useMemo(() => new Set(drafts.map((d) => d.type)), [drafts]);
    const availableMethods = useMemo(
      () => PAYMENT_METHOD_LIST.filter((m) => !usedTypes.has(m.type)),
      [usedTypes],
    );

    const updateDraft = (key: string, authority: string) => {
      setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, authority } : d)));
    };

    const removeDraft = (key: string) => {
      setDrafts((prev) => prev.filter((d) => d.key !== key));
    };

    const addDraft = (type: PaymentTargetType) => {
      setDrafts((prev) => [...prev, newDraft(type)]);
    };

    useImperativeHandle(ref, () => ({
      async save() {
        if (!user) return false;

        const cleaned: PaymentTarget[] = [];
        for (const d of drafts) {
          const authority = d.authority.trim();
          if (!authority) continue;
          const method = PAYMENT_METHODS[d.type];
          if (!method.validate(authority)) {
            toast({
              title: `Invalid ${method.label} address`,
              description: d.type === 'lightning'
                ? `"${authority}" doesn't look like a valid ${method.label} address.`
                : `"${authority}" doesn't look like a valid ${method.label} address/handle.`,
              variant: 'destructive',
            });
            return false;
          }
          cleaned.push({ type: d.type, authority });
        }

        // Skip unchanged publishes; one target per type makes a per-type signature order-insensitive.
        const signature = (list: PaymentTarget[]) =>
          list
            .map((t) => `${t.type}:${t.authority}`)
            .sort()
            .join('\n');
        if (signature(cleaned) === signature(targets)) {
          return true;
        }

        try {
          await updateTargets(cleaned);
          return true;
        } catch (err) {
          toast({
            title: 'Error',
            description:
              err instanceof Error ? err.message : 'Failed to save payment methods.',
            variant: 'destructive',
          });
          return false;
        }
      },
    }), [user, drafts, targets, updateTargets, toast]);

    if (!user) return null;

    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Accept Donations</h2>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            Let supporters send you crypto and tips.
          </p>
        </div>

        {isLoading && drafts.length === 0 ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading…
          </div>
        ) : drafts.length > 0 ? (
          <>
            <div className="space-y-2">
              {drafts.map((draft) => {
                const method = PAYMENT_METHODS[draft.type];
                return (
                  <div
                    key={draft.key}
                    className="flex items-center gap-3 clip-hairline-lg [--edge:var(--border)/0.5] [--fill:var(--card)/0.5] [--fill-hover:var(--card)/0.5] p-3"
                  >
                    <div className="flex items-center gap-2 w-28 shrink-0 text-sm font-medium">
                      <PaymentMethodIcon method={method} className="text-muted-foreground" />
                      <span className="truncate">{method.label}</span>
                    </div>
                    <Input
                      value={draft.authority}
                      onChange={(e) => updateDraft(draft.key, e.target.value)}
                      placeholder={method.placeholder}
                      className="h-9 flex-1 min-w-0 font-mono text-xs"
                      aria-label={`${method.label} address`}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeDraft(draft.key)}
                      className="h-9 w-9 touch:size-11 shrink-0 text-muted-foreground hover:text-destructive"
                      title={`Remove ${method.label}`}
                      aria-label={`Remove ${method.label}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                );
              })}
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={availableMethods.length === 0}
                  className="h-8 text-xs gap-1.5"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add method
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-44">
                {availableMethods.map((m) => (
                  <DropdownMenuItem key={m.type} onSelect={() => addDraft(m.type)} className="gap-2">
                    <PaymentMethodIcon method={m} />
                    <span>{m.label}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                disabled={availableMethods.length === 0}
                className="w-full h-11 gap-2 clip-corner-lg"
              >
                <Plus className="h-4 w-4" />
                Add donation
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-44">
              {availableMethods.map((m) => (
                <DropdownMenuItem key={m.type} onSelect={() => addDraft(m.type)} className="gap-2">
                  <PaymentMethodIcon method={m} />
                  <span>{m.label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    );
  },
);
