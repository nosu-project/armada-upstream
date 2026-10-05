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
  // Mobile (< md): top-positioned, swipe up.
  "max-md:data-[swipe=cancel]:translate-y-0 max-md:data-[swipe=end]:translate-y-[var(--radix-toast-swipe-end-y)] max-md:data-[swipe=move]:translate-y-[var(--radix-toast-swipe-move-y)] " +
  "max-md:data-[state=open]:slide-in-from-top-full max-md:data-[state=closed]:slide-out-to-top-full " +
  // Desktop (md+): top-right, off the composer; swipe right.
  "md:data-[swipe=cancel]:translate-x-0 md:data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] md:data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] " +
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

const Toast = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Root> &
    VariantProps<typeof toastVariants>
>(({ className, variant, ...props }, ref) => {
  return (
    <ToastPrimitives.Root
      ref={ref}
      className={cn(toastVariants({ variant }), className)}
      {...props}
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
