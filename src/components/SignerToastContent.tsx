import type { ReactNode } from "react";

/** Signer nudge toast body (see signerWithNudge). */
export function NudgeToastContent({
  description,
  onCancel,
}: {
  description: string;
  onCancel: () => void;
}): ReactNode {
  return (
    <span>
      <span className="block text-sm opacity-80">{description}</span>
      <span className="block mt-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="text-sm bg-transparent border-none p-0 cursor-pointer opacity-80 underline underline-offset-2 min-h-[44px] inline-flex items-center"
        >
          Skip
        </button>
      </span>
    </span>
  );
}
