import * as React from "react"

import { useBuzzMediaSrc } from "@/buzz/useBuzzMediaSrc"
import { cn } from "@/lib/utils"
import { type AvatarShape, isEmoji, getAvatarMaskUrl, isValidAvatarShape } from "@/lib/avatarShape"

/**
 * Shared ref so AvatarFallback can check if a sibling AvatarImage
 * has a src without needing state or effects. Mutating a ref during
 * render is safe — it doesn't trigger re-renders.
 */
const AvatarHasSrcContext = React.createContext<React.MutableRefObject<boolean>>({ current: false })

/** Context so children can inherit the shape for their own styling. */
const AvatarShapeContext = React.createContext<AvatarShape | undefined>(undefined)

export interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Avatar mask shape. Defaults to "circle" (the standard rounded-full). */
  shape?: AvatarShape;
}

const Avatar = React.forwardRef<HTMLDivElement, AvatarProps>(
  ({ className, children, shape, style, ...props }, ref) => {
    const hasSrcRef = React.useRef(false)
    // Reset per render so stale values don't persist
    hasSrcRef.current = false

    // Check if shape is valid (emoji)
    const hasValidShape = !!shape && isValidAvatarShape(shape)
    const isEmojiShape = hasValidShape && isEmoji(shape)
    const hasCustomShape = isEmojiShape

    // Compute mask URL synchronously — getAvatarMaskUrl renders the emoji
    // to a canvas and caches the data-URL, so subsequent calls are instant.
    // This avoids a flash of the unmasked square avatar on first paint.
    const maskUrl = hasCustomShape && shape ? getAvatarMaskUrl(shape) : ''

    const mergedStyle = React.useMemo<React.CSSProperties>(() => {
      if (maskUrl) {
        return {
          ...style,
          WebkitMaskImage: `url(${maskUrl})`,
          maskImage: `url(${maskUrl})`,
          WebkitMaskSize: 'contain',
          maskSize: 'contain' as string,
          WebkitMaskRepeat: 'no-repeat',
          maskRepeat: 'no-repeat' as string,
          WebkitMaskPosition: 'center',
          maskPosition: 'center' as string,
        }
      }
      return style ?? {}
    }, [maskUrl, style])

    return (
      <AvatarHasSrcContext.Provider value={hasSrcRef}>
        <AvatarShapeContext.Provider value={shape}>
          <div
            ref={ref}
            className={cn(
              "relative flex h-10 w-10 shrink-0 overflow-hidden bg-muted",
              !hasCustomShape && "rounded-full",
              className
            )}
            style={mergedStyle}
            {...props}
          >
            {children}
          </div>
        </AvatarShapeContext.Provider>
      </AvatarHasSrcContext.Provider>
    )
  }
)
Avatar.displayName = "Avatar"

/**
 * Rewrite a plain-http image URL to https. The APK's WebView (secure
 * https://localhost origin, MIXED_CONTENT_NEVER_ALLOW + the platform
 * cleartext block) silently drops http:// images that Chrome on the web
 * auto-upgrades, so old kind-0 pictures never rendered on native.
 */
function upgradeToHttps(src: string | undefined): string | undefined {
  if (src && /^http:\/\//i.test(src)) return "https://" + src.slice(7)
  return src
}

/** Timed retries after a failed load: 3s, 6s, 12s, 24s — then only on online/visible. */
const RETRY_BASE_MS = 3000
const MAX_TIMED_RETRIES = 4

/**
 * Renders the <img> immediately with absolute positioning so it covers
 * the fallback. No hidden Image() verification — the browser renders
 * the image progressively as it downloads.
 */
const AvatarImage = React.forwardRef<
  HTMLImageElement,
  React.ImgHTMLAttributes<HTMLImageElement>
>(({ className, onError, src: rawSrc, ...props }, ref) => {
  const [hasError, setHasError] = React.useState(false)
  const hasSrcRef = React.useContext(AvatarHasSrcContext)
  // Buzz-hosted avatars require a signed BUD-11 GET header a plain `<img src>`
  // can't send; useBuzzMediaSrc fetches them into an object URL and passes any
  // other URL straight through unchanged.
  const { src: resolvedSrc } = useBuzzMediaSrc(typeof rawSrc === "string" ? rawSrc : undefined)
  const src = upgradeToHttps(resolvedSrc)

  // Reset error state when src changes
  const prevSrc = React.useRef(src)
  const attemptsRef = React.useRef(0)
  if (src !== prevSrc.current) {
    prevSrc.current = src
    attemptsRef.current = 0
    if (hasError) setHasError(false)
  }

  // A failed load must NOT latch the fallback forever: transient fetch
  // failures are routine on mobile (radio not up at cold start, Doze, the
  // WebView freezing in-flight loads on background→foreground), and this
  // component stays mounted across them. Retry with backoff, and whenever
  // the network or the app comes back — remounting the <img> re-issues the
  // fetch.
  React.useEffect(() => {
    if (!hasError) return
    const retry = () => setHasError(false)
    const timer = attemptsRef.current <= MAX_TIMED_RETRIES
      ? setTimeout(retry, RETRY_BASE_MS * 2 ** (attemptsRef.current - 1))
      : undefined
    const onVisible = () => {
      if (document.visibilityState === "visible") retry()
    }
    window.addEventListener("online", retry)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      window.removeEventListener("online", retry)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [hasError])

  const showImage = !hasError && !!src

  // Signal to AvatarFallback synchronously during this render frame
  if (showImage) {
    hasSrcRef.current = true
  }

  if (!showImage) return null

  return (
    <img
      {...props}
      src={src}
      ref={ref}
      alt=""
      // Avatars come from arbitrary third-party hosts; a `Referer:
      // https://localhost/` from the APK's WebView trips some hotlink
      // protections that never see it from the web origin.
      referrerPolicy="no-referrer"
      className={cn("absolute inset-0 h-full w-full object-cover", className)}
      onError={(e) => {
        attemptsRef.current += 1
        setHasError(true)
        onError?.(e)
      }}
    />
  )
})
AvatarImage.displayName = "AvatarImage"

/**
 * Fallback content (letter initial). Hidden when AvatarImage has a src,
 * so there's no flash of the letter while the image downloads. The
 * Avatar's bg-muted background provides the placeholder color instead.
 */
const AvatarFallback = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  const hasSrcRef = React.useContext(AvatarHasSrcContext)
  const shape = React.useContext(AvatarShapeContext)

  const hasCustomShape = !!shape && isValidAvatarShape(shape)

  // AvatarImage renders before AvatarFallback (DOM order), so hasSrcRef
  // is already set by the time we read it here in the same render frame.
  if (hasSrcRef.current) return null

  return (
    <div
      ref={ref}
      className={cn(
        "flex h-full w-full items-center justify-center",
        !hasCustomShape && "rounded-full",
        className
      )}
      {...props}
    />
  )
})
AvatarFallback.displayName = "AvatarFallback"

export { Avatar, AvatarImage, AvatarFallback }
