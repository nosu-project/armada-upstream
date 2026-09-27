import { cn } from "@/lib/utils"

/**
 * A loading placeholder. It pulses for a few cycles (~16s) and then rests at
 * full opacity: a load that stalls is otherwise an animation that never ends,
 * and a screenful of pulsing rows kept a phone's compositor and GPU producing
 * frames — about 40% of a core, measured — for as long as nothing arrived.
 */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse [animation-iteration-count:8] rounded-md bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
