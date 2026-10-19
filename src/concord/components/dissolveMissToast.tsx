import { ToastAction } from "@/components/ui/toast";

import type { toast } from "@/hooks/useToast";
import { common, t } from "@/i18n";

/** Toast for a partially failed dissolve (links or Discover listings still live), with Retry. */
export function dissolveMissToast(
  missed: { revokeFailed: boolean; unlistFailed: boolean },
  onRetry: () => void,
): Parameters<typeof toast>[0] {
  const description =
    missed.revokeFailed && missed.unlistFailed
      ? t({
          id: "dissolveMissToast.bothFailed",
          defaultMessage:
            "The community is dissolved, but some of your invite links still work and some of your Discover listings are still up.",
        })
      : missed.revokeFailed
        ? t({
            id: "dissolveMissToast.revokeFailed",
            defaultMessage:
              "The community is dissolved and your Discover listings are removed, but some of your invite links couldn't be revoked and still work.",
          })
        : t({
            id: "dissolveMissToast.unlistFailed",
            defaultMessage:
              "The community is dissolved and your invite links are revoked, but some of your Discover listings couldn't be removed.",
          });
  return {
    title: t({
      id: "dissolveMissToast.title",
      defaultMessage: "Community dissolved, but not everything was taken down",
    }),
    description,
    variant: "destructive",
    action: (
      <ToastAction
        altText={t({
          id: "dissolveMissToast.retryAlt",
          defaultMessage: "Retry taking down invite links and listings",
        })}
        onClick={onRetry}
      >
        {t(common.retry)}
      </ToastAction>
    ),
  };
}
