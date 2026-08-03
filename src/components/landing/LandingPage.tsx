import { useEffect, useRef, useState } from "react";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { BrandMark } from "@/components/brand/BrandMark";
import { Button } from "@/components/ui/button";
import { STOCK_RELAYS } from "@/concord-v2/lib/invite";
import { relayToHttpUrl } from "@/lib/platform";
import { cn } from "@/lib/utils";

import { AsciiSea } from "./AsciiSea";

/**
 * The signed-out landing page: the crest, wordmark and Join button over the
 * {@link AsciiSea}, with a single statement below that the hero's "How does
 * Armada work?" cue scrolls into. Scrolling raises the sea's waterline until
 * the statement floats on open water.
 */

/** True when the user has asked the OS to keep motion to a minimum. */
function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function LandingPage({
  onJoin,
  scrollRef,
}: {
  /** Opens the login dialog, the canonical logged-out CTA. */
  onJoin: () => void;
  scrollRef: React.RefObject<HTMLElement | null>;
}) {
  const statementRef = useRef<HTMLElement>(null);

  const scrollToStatement = () => {
    statementRef.current?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "start",
    });
  };

  return (
    <>
      {/*
        Viewport-locked sea. `sticky` pins it while `-mb-[100svh]` cancels the
        height it would otherwise add to the scroll length, so the content
        below starts at the top of the page and scrolls straight over it.
      */}
      <div className="pointer-events-none sticky top-0 z-0 -mb-[100svh] h-[100svh]">
        <AsciiSea scrollRef={scrollRef} />
      </div>

      <div className="relative z-10">
        {/* ── Hero ────────────────────────────────────────────────────── */}
        <section className="mx-auto flex min-h-[100svh] max-w-xl flex-col items-center justify-center gap-10 px-6 py-16 safe-area-top">
          <div className="flex flex-col items-center gap-8">
            <ArmadaCrest size={150} />
            <BrandMark />
          </div>

          <div className="w-full max-w-sm">
            <Button
              size="lg"
              onClick={onJoin}
              className="h-12 w-full clip-corner-lg text-base font-medium"
            >
              Join
            </Button>
            {/* Cue and scroll target are one control: the statement below IS
                the answer, so a detached arrow read as a second affordance. */}
            <button
              type="button"
              onClick={scrollToStatement}
              className="group mt-5 flex w-full flex-col items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              How does Armada work?
              {/* U+2193 (↓), not a fancier chevron/triangle-headed arrow: it's
                  in the WGL4 core set, so Android's default Roboto (and every
                  other system font) has a real glyph instead of tofu. Kept off
                  `font-mono` for the same reason — the UI stack is the safest. */}
              <span
                aria-hidden="true"
                className="animate-[armada-bob_2.4s_ease-in-out_infinite] text-base leading-none text-[hsl(var(--accent2)/0.75)] group-hover:text-[hsl(var(--accent2))]"
              >
                &#8595;
              </span>
            </button>
          </div>
        </section>

        {/* ── The statement ────────────────────────────────────────────── */}
        <section
          ref={statementRef}
          className="mx-auto flex min-h-[100svh] max-w-2xl flex-col items-center justify-center gap-3 px-6 py-16 text-center safe-area-bottom"
        >
          <p className="font-mono text-xl font-bold tracking-tight text-muted-foreground sm:text-2xl">
            Chat apps belong to whoever runs the servers.
          </p>
          <p className="font-mono text-xl font-bold tracking-tight text-foreground sm:text-2xl">
            Armada is spread across free public servers.
          </p>

          {/* The receipts for the claim above — a caption strip, not a second
              block of copy, so it stays subordinate to the statement. */}
          <ul className="mt-14 flex flex-wrap items-center justify-center gap-x-6 gap-y-2.5 font-mono text-xs text-muted-foreground/70">
            {STOCK_RELAYS.map((url) => <RelayLight key={url} url={url} />)}
          </ul>
          <a
            href="https://soapbox.pub/blog/how-to-self-host-armada"
            target="_blank"
            rel="noreferrer"
            className="mt-5 font-mono text-xs tracking-wide text-muted-foreground/70 underline decoration-muted-foreground/30 underline-offset-4 transition-colors hover:text-foreground hover:decoration-current"
          >
            Host your own
          </a>
        </section>
      </div>

      <ArmadaCrestKeyframes />
      <LandingKeyframes />
    </>
  );
}

/**
 * One default relay with a liveness light: green when a HEAD to its NIP-11
 * endpoint answers 2xx, red otherwise. HEAD with the `application/nostr+json`
 * accept header is a simple CORS request, so no preflight is needed.
 */
function RelayLight({ url }: { url: string }) {
  const [alive, setAlive] = useState<boolean>();

  useEffect(() => {
    let cancelled = false;
    fetch(relayToHttpUrl(url), {
      method: "HEAD",
      headers: { accept: "application/nostr+json" },
      signal: AbortSignal.timeout(8000),
    })
      .then((res) => !cancelled && setAlive(res.ok))
      .catch(() => !cancelled && setAlive(false));
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <li className="flex items-center gap-2 tracking-wide">
      {/* A status light, not a bullet: small, with a soft halo so the lit
          state reads at a glance without out-shouting the muted caption. */}
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full ring-2",
          alive === undefined && "animate-pulse bg-muted-foreground/40 ring-transparent motion-reduce:animate-none",
          alive === true && "bg-emerald-400 ring-emerald-400/20",
          alive === false && "bg-red-400/80 ring-red-400/15",
        )}
      />
      {url.replace(/^wss:\/\//, "")}
      <span className="sr-only">
        {alive === undefined ? "(checking)" : alive ? "(online)" : "(offline)"}
      </span>
    </li>
  );
}

/** Landing-only keyframes, scoped the same way {@link ArmadaCrestKeyframes} is. */
function LandingKeyframes() {
  return (
    <style>{`
      /* The scroll cue riding the swell. Transform only. */
      @keyframes armada-bob {
        0%, 100% { transform: translateY(0); opacity: 0.55; }
        50%      { transform: translateY(0.4rem); opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) {
        [class*="animate-[armada-bob"] { animation: none !important; }
      }
    `}</style>
  );
}
