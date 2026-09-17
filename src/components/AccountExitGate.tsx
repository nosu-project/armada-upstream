import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { BrandMark } from "@/components/brand/BrandMark";
import { SignalStatic } from "@/components/brand/SignalStatic";
import { TerminalProgress } from "@/components/brand/TerminalProgress";
import { useAccountExit } from "@/components/accountExitState";

/**
 * Full-screen account-exit overlay — the {@link SyncGate} login sequence played
 * in reverse.
 *
 * Logging out or switching accounts runs a bounded, best-effort teardown and
 * then navigates. That window used to pass with no feedback at all — the
 * dropdown closed and the app sat on the old screen — so a press read as no
 * press. The exit paths now raise this overlay synchronously on click and
 * report each real step as it runs, and it draws them the way the user already
 * knows the jack-in: the crest, the dead-channel static, and a terminal log
 * naming exactly what is taking time. Where the sync gate CLEARS the static as
 * the link comes up, this one lets it BURY the screen as the link goes down.
 *
 * Mounted at the app root (above the signed-in gate) so it outlives the login
 * being cleared moments before the reload — see the store's note. It renders
 * nothing until an exit is in flight, and never takes itself down: the reload
 * is what clears the screen.
 */
export function AccountExitGate() {
  const exit = useAccountExit();
  if (!exit) return null;

  const { kind, seed, log } = exit;
  const tagline = kind === "logout" ? "jacking out" : "switching identities";
  // 1ch is one glyph in the mono wordmark, so the typewriter's full width is
  // exactly the tagline's length — computed here rather than hard-coded so the
  // caret lands flush against the last glyph for either wording.
  const len = tagline.length;

  // Interference RISES as the link tears down: the reverse of the sync gate,
  // where every resolved phase drops it a notch. Each settled teardown step
  // buries the screen a little further toward a dead channel.
  const resolvedCount = log.filter((line) => line.status !== undefined).length;
  const staticLevel = Math.min(0.55, 0.12 + 0.14 * resolvedCount);

  // Fingerprint of the teardown's progress — changes on every log mutation, and
  // SignalStatic ripples a band on each change.
  const wireSignal = log.map((line) => `${line.id}:${line.status ?? ""}`).join("|");

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-10 overflow-hidden bg-background px-6"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-6">
        <ArmadaCrest size={96} />
        <BrandMark
          tagline={
            // A CSS typewriter, the mirror of the gate's "jacking in": the
            // caret BrandMark sits right after the span rides the erased edge.
            // Reduced motion kills the animation and the span falls back to its
            // natural (full) width. Steps follow the glyph count.
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

      {/* Over the content, visor-fashion: the interference is between the
          operator and the feed as the signal drops out, not scenery behind it. */}
      <SignalStatic level={staticLevel} seed={seed} signal={wireSignal} />

      <ArmadaCrestKeyframes />
      {/* Exit-only keyframes: hold the full line, wipe it back to nothing, hold
          empty, then retype — the login gate's type/hold/erase loop reversed.
          Full width follows the tagline's glyph count. */}
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
