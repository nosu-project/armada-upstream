import * as React from "react"
import * as ToastPrimitives from "@radix-ui/react-toast"
import { cva, type VariantProps } from "class-variance-authority"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

const ToastProvider = ToastPrimitives.Provider

const ToastViewport = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Viewport>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Viewport>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Viewport
    ref={ref}
    className={cn(
      "vessel-lift fixed top-0 z-[300] flex max-h-screen w-full flex-col-reverse gap-2 p-4 pt-[max(1rem,var(--safe-area-inset-top,env(safe-area-inset-top)))] md:right-0 md:pt-4 md:max-w-[420px]",
      className
    )}
    {...props}
  />
))
ToastViewport.displayName = ToastPrimitives.Viewport.displayName

const toastVariants = cva(
  // A chrome vessel whose left tick and hairline carry the tone (`--tone`).
  "vessel group pointer-events-auto relative flex w-full items-center justify-between gap-3 overflow-hidden py-3.5 pl-5 pr-10 text-popover-foreground transition-all data-[swipe=move]:transition-none " +
  "before:absolute before:left-px before:top-3 before:bottom-3 before:w-0.5 before:rounded-full before:bg-[hsl(var(--tone))] before:shadow-[0_0_8px_hsl(var(--tone)/0.7)] before:content-[''] " +
  "data-[state=open]:animate-in data-[state=closed]:animate-out data-[swipe=end]:animate-out data-[state=closed]:fade-out-80 " +
  // Swipe left, right or up (see useToastSwipe); the exit slide follows the swipe.
  "data-[swipe=move]:translate-x-[var(--toast-swipe-x)] data-[swipe=move]:translate-y-[var(--toast-swipe-y)] " +
  "data-[swipe=end]:translate-x-[var(--toast-swipe-x)] data-[swipe=end]:translate-y-[var(--toast-swipe-y)] " +
  // Mobile (< md): top-positioned.
  "max-md:data-[state=open]:slide-in-from-top-full max-md:data-[state=closed]:slide-out-to-top-full " +
  // Desktop (md+): top-right, off the composer.
  "md:data-[state=open]:slide-in-from-right-full md:data-[state=closed]:slide-out-to-right-full",
  {
    variants: {
      variant: {
        default: "[--tone:var(--primary)]",
        destructive:
          "destructive [--tone:var(--destructive)] [--vessel-edge:hsl(var(--destructive)/0.3)] [--vessel-fill:linear-gradient(hsl(var(--destructive)/0.1),hsl(var(--destructive)/0.1))_hsl(var(--popover))]",
        success:
          "success [--tone:var(--success)] [--vessel-edge:hsl(var(--success)/0.3)] [--vessel-fill:linear-gradient(hsl(var(--success)/0.1),hsl(var(--success)/0.1))_hsl(var(--popover))]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

const SWIPE_THRESHOLD = 30

type SwipeHandlers = Pick<
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Root>,
  "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel"
>

/**
 * Radix Toast swipes in one fixed direction, so the gesture is ours: left,
 * right or up. `preventDefault` on pointerdown keeps Radix's own handler from
 * starting a competing swipe (its handlers skip a prevented event).
 */
function useToastSwipe(
  onDismiss: (() => void) | undefined,
  { onPointerDown, onPointerMove, onPointerUp, onPointerCancel }: SwipeHandlers,
): Required<SwipeHandlers> {
  const startRef = React.useRef<{ x: number; y: number } | null>(null)
  const axisRef = React.useRef<"x" | "y" | null>(null)
  const deltaRef = React.useRef<{ x: number; y: number } | null>(null)
  const dismissRef = React.useRef(onDismiss)
  dismissRef.current = onDismiss

  return React.useMemo(() => {
    const finish = (event: React.PointerEvent<HTMLLIElement>, canDismiss: boolean) => {
      const el = event.currentTarget
      const delta = deltaRef.current
      if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId)
      startRef.current = null
      axisRef.current = null
      deltaRef.current = null
      if (!delta) return
      // A swipe that ends over the close button or an action is not a click.
      el.addEventListener("click", (e) => e.preventDefault(), { once: true })
      if (canDismiss && (Math.abs(delta.x) >= SWIPE_THRESHOLD || -delta.y >= SWIPE_THRESHOLD)) {
        el.setAttribute("data-swipe", "end")
        el.style.setProperty("--tw-exit-translate-x", delta.x ? `${Math.sign(delta.x) * 100}%` : "0")
        el.style.setProperty("--tw-exit-translate-y", delta.x ? "0" : "-100%")
        dismissRef.current?.()
      } else {
        el.setAttribute("data-swipe", "cancel")
        el.style.removeProperty("--toast-swipe-x")
        el.style.removeProperty("--toast-swipe-y")
      }
    }

    return {
      onPointerDown: (event) => {
        onPointerDown?.(event)
        if (event.defaultPrevented || event.button !== 0) return
        event.preventDefault()
        startRef.current = { x: event.clientX, y: event.clientY }
      },
      onPointerMove: (event) => {
        onPointerMove?.(event)
        const start = startRef.current
        if (!start) return
        const dx = event.clientX - start.x
        const dy = event.clientY - start.y
        const el = event.currentTarget
        if (!axisRef.current) {
          const buffer = event.pointerType === "touch" ? 10 : 2
          if (Math.abs(dx) <= buffer && Math.abs(dy) <= buffer) return
          if (Math.abs(dx) > Math.abs(dy)) axisRef.current = "x"
          else if (dy < 0) axisRef.current = "y"
          else {
            startRef.current = null
            return
          }
          el.setPointerCapture(event.pointerId)
        }
        const delta = axisRef.current === "x" ? { x: dx, y: 0 } : { x: 0, y: Math.min(0, dy) }
        deltaRef.current = delta
        el.setAttribute("data-swipe", "move")
        el.style.setProperty("--toast-swipe-x", `${delta.x}px`)
        el.style.setProperty("--toast-swipe-y", `${delta.y}px`)
      },
      onPointerUp: (event) => {
        onPointerUp?.(event)
        finish(event, true)
      },
      onPointerCancel: (event) => {
        onPointerCancel?.(event)
        finish(event, false)
      },
    }
  }, [onPointerDown, onPointerMove, onPointerUp, onPointerCancel])
}

const Toast = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Root> &
    VariantProps<typeof toastVariants>
>(({ className, variant, onOpenChange, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, ...props }, ref) => {
  const swipe = useToastSwipe(
    onOpenChange && (() => onOpenChange(false)),
    { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  )
  return (
    <ToastPrimitives.Root
      ref={ref}
      className={cn(toastVariants({ variant }), className)}
      onOpenChange={onOpenChange}
      {...props}
      {...swipe}
    />
  )
})
Toast.displayName = ToastPrimitives.Root.displayName

const ToastAction = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Action>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Action>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Action
    ref={ref}
    className={cn(
      "inline-flex h-8 touch:h-11 shrink-0 items-center justify-center clip-corner bg-primary/15 px-3 text-sm font-medium text-primary transition-colors hover:bg-primary/25 focus:outline-none focus-visible:bg-primary/25 disabled:pointer-events-none disabled:opacity-50 group-[.destructive]:bg-destructive group-[.destructive]:text-destructive-foreground group-[.destructive]:hover:bg-destructive/85 group-[.success]:bg-success/20 group-[.success]:text-foreground group-[.success]:hover:bg-success/30",
      className
    )}
    {...props}
  />
))
ToastAction.displayName = ToastPrimitives.Action.displayName

const ToastClose = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Close>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Close>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Close
    ref={ref}
    className={cn(
      "absolute right-2 top-2 clip-corner p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus:opacity-100 focus:outline-none focus-visible:bg-foreground/10 group-hover:opacity-100",
      className
    )}
    toast-close=""
    {...props}
  >
    <X className="h-4 w-4" />
  </ToastPrimitives.Close>
))
ToastClose.displayName = ToastPrimitives.Close.displayName

const ToastTitle = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Title>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Title>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Title
    ref={ref}
    className={cn("text-sm font-semibold", className)}
    {...props}
  />
))
ToastTitle.displayName = ToastPrimitives.Title.displayName

const ToastDescription = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Description>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Description>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
ToastDescription.displayName = ToastPrimitives.Description.displayName

type ToastProps = React.ComponentPropsWithoutRef<typeof Toast>

type ToastActionElement = React.ReactElement<typeof ToastAction>

export {
  type ToastProps,
  type ToastActionElement,
  ToastProvider,
  ToastViewport,
  Toast,
  ToastTitle,
  ToastDescription,
  ToastClose,
  ToastAction,
}
