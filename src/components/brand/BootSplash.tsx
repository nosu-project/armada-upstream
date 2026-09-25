import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";

/**
 * Full-screen branded splash for boot-time waits: shown while the cold-launch
 * deep link resolves (HomeRedirect) and as the Suspense fallback while a
 * lazy-loaded route chunk downloads/parses. Replaces the blank screen those
 * waits used to render — a dead black frame reads as "hung", the crest reads
 * as "starting".
 */
export function BootSplash() {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background"
      role="status"
      aria-label="Loading"
    >
      <ArmadaCrest size={96} loop />
      <ArmadaCrestKeyframes />
    </div>
  );
}

/**
 * The same full-screen wait, with no mark and no motion.
 *
 * Used only where the destination is the welcome screen, which draws the crest
 * itself the moment it paints: showing it here too started the ~1.1s draw,
 * cut it off as soon as the route resolved, and handed over to a second,
 * restarting draw. Everywhere else keeps {@link BootSplash}.
 */
export function BlankSplash() {
  return <div className="fixed inset-0 z-50 bg-background" role="status" aria-label="Loading" />;
}

export default BootSplash;
