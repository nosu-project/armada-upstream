import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { useIntl } from "@/i18n";

/** Full-screen branded splash for boot-time waits (cold deep link, route chunks). */
export function BootSplash() {
  const intl = useIntl();
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background"
      role="status"
      aria-label={intl.formatMessage({ id: "bootSplash.loading", defaultMessage: "Loading" })}
    >
      <ArmadaCrest size={96} loop />
      <ArmadaCrestKeyframes />
    </div>
  );
}

/**
 * The same wait with no mark, for when the destination (welcome screen) draws
 * the crest itself; otherwise the draw would restart.
 */
export function BlankSplash() {
  const intl = useIntl();
  return <div className="fixed inset-0 z-50 bg-background" role="status" aria-label={intl.formatMessage({ id: "bootSplash.loading", defaultMessage: "Loading" })} />;
}

export default BootSplash;
