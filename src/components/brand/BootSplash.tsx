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
      <ArmadaCrest size={96} />
      <ArmadaCrestKeyframes />
    </div>
  );
}

export default BootSplash;
