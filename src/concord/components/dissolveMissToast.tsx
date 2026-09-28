import { ToastAction } from "@/components/ui/toast";

import type { toast } from "@/hooks/useToast";

/** Toast for a partially failed dissolve (links or Discover listings still live), with Retry. */
export function dissolveMissToast(
  missed: { revokeFailed: boolean; unlistFailed: boolean },
  onRetry: () => void,
): Parameters<typeof toast>[0] {
  const description =
    missed.revokeFailed && missed.unlistFailed
      ? "The community is dissolved, but some of your invite links still work and some of your Discover listings are still up."
      : missed.revokeFailed
        ? "The community is dissolved and your Discover listings are removed, but some of your invite links couldn't be revoked and still work."
        : "The community is dissolved and your invite links are revoked, but some of your Discover listings couldn't be removed.";
  return {
    title: "Community dissolved — not everything was taken down",
    description,
    variant: "destructive",
    action: (
      <ToastAction altText="Retry taking down invite links and listings" onClick={onRetry}>
        Retry
      </ToastAction>
    ),
  };
}
