import { useEffect, useMemo, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  cashuMintLabel,
  type CashuTokenInfo,
  type CashuTokenState,
  checkCashuTokenState,
  formatCashuAmount,
  parseCashuToken,
  stripCashuScheme,
} from "@/lib/cashu";
import { writeClipboardText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

/**
 * Card for a Cashu ecash token pasted into chat.
 *
 * The token is a bearer instrument — the card only displays it and offers a
 * copy, so it can be pasted into a wallet. Nothing here redeems: Armada has no
 * ecash wallet, and auto-claiming on render would silently spend a token every
 * viewer can see.
 */
export function CashuToken({ raw, className }: { raw: string; className?: string }) {
  const info = useMemo(() => parseCashuToken(raw), [raw]);

  // Undecodable payload: fall back to the raw string rather than an empty card.
  if (!info) return <span className="break-all">{raw}</span>;

  return <CashuTokenCard info={info} token={stripCashuScheme(raw)} className={className} />;
}

type CheckStatus = "checking" | "error" | CashuTokenState;

function CashuTokenCard({
  info,
  token,
  className,
}: {
  info: CashuTokenInfo;
  token: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<CheckStatus>("checking");

  // Ask the mint whether the token is still spendable (NUT-07). The request
  // goes to a URL that came out of a chat message, which is the same exposure
  // the timeline already accepts for inline images; it is read-only and sends
  // nothing that could spend the token.
  useEffect(() => {
    let cancelled = false;
    checkCashuTokenState(info).then((result) => {
      if (!cancelled) setStatus(result ?? "error");
    });
    return () => {
      cancelled = true;
    };
  }, [info]);

  const spent = status === "spent";

  const copy = () => {
    writeClipboardText(token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => undefined);
  };

  return (
    <div
      className={cn(
        // No border: the chamfer clips it into a broken outline, so the
        // cut-corner chrome elsewhere is fill-only too.
        "relative block max-w-sm w-full clip-corner-lg bg-secondary/40 overflow-hidden my-1.5",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {/* The chamfer cuts the top-left and bottom-right corners, so the
          top-right is square and safe to hang the controls in. */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="absolute right-1 top-1 inline-flex size-8 touch:size-11 items-center justify-center clip-corner-lg text-muted-foreground transition-colors hover:bg-background/40 hover:text-foreground"
            aria-label="About this token"
          >
            <span aria-hidden className="text-sm leading-none">🥜</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="space-y-3">
          <p className="text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Cashu ecash
          </p>

          <div className="space-y-0.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Mint
            </p>
            <p className="text-sm break-all" title={info.mint || undefined}>
              {cashuMintLabel(info.mint)}
            </p>
          </div>

          <div className="space-y-0.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Token
            </p>
            <button
              type="button"
              className="block w-full truncate text-left font-mono text-xs"
              onClick={copy}
              title="Copy token"
            >
              {copied ? "Copied!" : token}
            </button>
          </div>
        </PopoverContent>
      </Popover>

      <div className="px-3.5 py-3 space-y-2.5 text-center">
        {/* Symmetric inset keeps the centered amount clear of the info button's
            44px touch target in the corner. */}
        <div className="flex items-baseline justify-center gap-2 min-w-0 px-10">
          <span className="text-xl font-semibold text-amber-500 truncate">
            {formatCashuAmount(info.amount, info.unit)}
          </span>
          {info.proofs > 1 && (
            <span className="text-xs text-muted-foreground shrink-0">
              {info.proofs} proofs
            </span>
          )}
        </div>

        {info.memo && (
          <p className="text-sm text-foreground/90 break-words">{info.memo}</p>
        )}

        <button
          type="button"
          className="w-full px-2.5 py-2 touch:py-2.5 clip-corner-lg bg-amber-500/20 text-amber-500 text-xs font-medium transition-colors hover:bg-amber-500/30 disabled:bg-destructive/20 disabled:text-destructive disabled:hover:bg-destructive/20"
          onClick={copy}
          disabled={spent}
          title={spent ? undefined : "Copy the token to redeem it in an ecash wallet"}
        >
          {spent ? "Already redeemed" : copied ? "Copied!" : "Copy token"}
        </button>
      </div>
    </div>
  );
}
