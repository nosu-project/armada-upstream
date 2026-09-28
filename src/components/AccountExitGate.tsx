import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { BrandMark } from "@/components/brand/BrandMark";
import { SignalStatic } from "@/components/brand/SignalStatic";
import { TerminalProgress } from "@/components/brand/TerminalProgress";
import { useAccountExit } from "@/components/accountExitState";

/**
 * Full-screen account-exit overlay: the {@link SyncGate} login sequence in
 * reverse, reporting each teardown step. Mounted above the signed-in gate so it
 * outlives the login being cleared before the reload; never takes itself down.
 */
export function AccountExitGate() {
  const exit = useAccountExit();
  if (!exit) return null;

  const { kind, seed, log } = exit;
  const tagline = kind === "logout" ? "jacking out" : "switching identities";
  // 1ch is one mono glyph, so the caret lands flush for either wording.
  const len = tagline.length;

  // Interference RISES with each settled teardown step (the sync gate's reverse).
  const resolvedCount = log.filter((line) => line.status !== undefined).length;
  const staticLevel = Math.min(0.55, 0.12 + 0.14 * resolvedCount);

  // Changes on every log mutation; SignalStatic ripples a band on each change.
  const wireSignal = log.map((line) => `${line.id}:${line.status ?? ""}`).join("|");

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-10 overflow-hidden bg-background px-6"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-6">
        <ArmadaCrest size={96} loop />
        <BrandMark
          tagline={
            // Reduced motion kills the animation; the span falls back to full width.
            <span
              className="inline-block overflow-hidden whitespace-nowrap align-bottom motion-reduce:!animate-none"
              style={{ animation: `armada-untype 3.5s steps(${len}, end) infinite` }}
            >
              {tagline}
            </span>
          }
        />
      </div>

      {log.length > 0 && (
        <div className="w-full max-w-sm">
          <TerminalProgress lines={log} />
        </div>
      )}

      <SignalStatic level={staticLevel} seed={seed} signal={wireSignal} />

      <ArmadaCrestKeyframes />
      {/* Exit-only keyframes: the login gate's type/hold/erase loop reversed. */}
      <style>{`
        @keyframes armada-untype {
          0%, 24% { width: ${len}ch; }
          56%, 74% { width: 0ch; }
          100% { width: ${len}ch; }
        }
      `}</style>
    </div>
  );
}

export default AccountExitGate;
