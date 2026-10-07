import { useRelayReachable } from "@/hooks/useRelayReachable";
import { cn } from "@/lib/utils";

/** Cheap stable hash so each light blinks out of phase without a caller-supplied index. */
function phase(url: string): number {
  let h = 0;
  for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) | 0;
  return (h >>> 0) % 7;
}

/** Relay status light (keyframes in index.css): grey while checking, blinking green when up, a red fault pulse when down. */
export function RelayLed({ url, phase: phaseIndex, className }: { url: string; phase?: number; className?: string }) {
  const alive = useRelayReachable(url);
  const p = phaseIndex ?? phase(url);
  const label = alive === undefined ? "Checking relay" : alive ? "Relay reachable" : "Relay unreachable";

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      style={
        alive === undefined
          ? undefined
          : alive
            ? { animationDelay: `${p * 0.29}s`, animationDuration: `${1.15 + p * 0.13}s` }
            : { animationDelay: `${p * 0.11}s` }
      }
      className={cn(
        "size-1.5 shrink-0 rounded-full ring-2",
        alive === undefined && "animate-pulse bg-muted-foreground/40 ring-transparent motion-reduce:animate-none",
        alive === true &&
          "animate-[armada-led-busy_1.15s_steps(1,end)_infinite] bg-emerald-400 text-emerald-400/60 ring-emerald-400/20 shadow-[0_0_5px_1px_currentColor] motion-reduce:animate-none",
        alive === false &&
          "animate-[armada-led-fault_1.9s_steps(1,end)_infinite] bg-red-400 text-red-400/50 ring-red-400/15 shadow-[0_0_4px_0_currentColor] motion-reduce:animate-none",
        className,
      )}
    />
  );
}
