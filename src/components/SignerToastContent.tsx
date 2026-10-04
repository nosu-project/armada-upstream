import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

export interface SignerAppLink {
  href: string;
  label: string;
}

/** Signer nudge toast body (see signerWithNudge). */
export function NudgeToastContent({
  description,
  openSigner,
  onCancel,
}: {
  description: string;
  openSigner?: SignerAppLink[];
  onCancel: () => void;
}): ReactNode {
  return (
    <span>
      <span className="block text-sm opacity-80">{description}</span>
      {openSigner && openSigner.length > 0 ? (
        <OpenSignerRow links={openSigner} onCancel={onCancel} />
      ) : (
        <span className="block mt-1.5">
          <SkipButton onClick={onCancel} />
        </span>
      )}
    </span>
  );
}

function OpenSignerRow({ links, onCancel }: { links: SignerAppLink[]; onCancel: () => void }) {
  const [waiting, setWaiting] = useState(false);

  return (
    <span className="flex flex-wrap items-center gap-3 mt-2">
      {waiting ? (
        <span className="text-sm opacity-80 inline-flex items-center gap-1.5">
          <Loader2 className="size-4 animate-spin" />
          Waiting for signer…
        </span>
      ) : (
        links.map((link) => (
          <Button key={link.href} asChild variant="secondary" size="sm">
            <a href={link.href} onClick={() => setWaiting(true)}>
              {link.label}
            </a>
          </Button>
        ))
      )}
      {waiting ? (
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      ) : (
        <SkipButton onClick={onCancel} />
      )}
    </span>
  );
}

function SkipButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-sm bg-transparent border-none p-0 cursor-pointer opacity-80 underline underline-offset-2 min-h-[44px] inline-flex items-center"
    >
      Skip
    </button>
  );
}
