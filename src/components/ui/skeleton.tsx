import { cn } from "@/lib/utils"

/** Pulses ~16s then rests: an endless pulse cost ~40% of a phone core while a load stalled. */
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
