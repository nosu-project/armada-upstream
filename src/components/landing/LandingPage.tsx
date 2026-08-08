import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { BrandMark } from "@/components/brand/BrandMark";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { RELAY_DICTIONARY } from "@/concord/lib/stockRelays";
import { relayToHttpUrl } from "@/lib/platform";
import { cn } from "@/lib/utils";

import { AsciiSea } from "./AsciiSea";
import { EncryptionQuiz } from "./EncryptionQuiz";

/**
 * The signed-out landing page: the crest, wordmark and Join button over the
 * {@link AsciiSea}, with a single statement below that the hero's "How does
 * Armada work?" cue scrolls into. Scrolling raises the sea's waterline until
 * the statement floats on open water.
 */

/**
 * The stock relays in landing-page display order. Display order only — the
 * dictionary ids (and STOCK_RELAYS' order) are the CORD-05 wire format and
 * stay fixed.
 */
const LANDING_RELAYS: string[] = [3, 1, 4, 2].map((i) => RELAY_DICTIONARY[i]);

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
          className="mx-auto flex min-h-[100svh] max-w-5xl flex-col items-center justify-center gap-4 px-6 py-16 text-center sm:gap-5"
        >
          {/* `text-balance` because each line only fits on one line on a wide
              viewport — where it has to wrap, both halves stay even rather
              than leaving one word stranded. */}
          <p className="text-balance font-mono text-2xl font-bold tracking-tight text-muted-foreground sm:text-3xl lg:text-4xl">
            Chat apps belong to whoever runs the servers.
          </p>
          <p className="text-balance font-mono text-2xl font-bold tracking-tight text-foreground sm:text-3xl lg:text-4xl">
            Armada is spread across free public servers.
          </p>

          {/* The receipts for the claim above — a caption strip, not a second
              block of copy, so it stays subordinate to the statement. */}
          <ul className="mt-14 flex flex-wrap items-center justify-center gap-x-6 gap-y-2.5 font-mono text-xs text-muted-foreground/70">
            {LANDING_RELAYS.map((url, i) => <RelayLight key={url} url={url} index={i} />)}
            {/* The defaults are a starting point, not the set — the rest of
                the network is one link away, so no light to check. */}
            <li className="tracking-wide">
              <a
                href="https://nostr.watch/"
                target="_blank"
                rel="noreferrer"
                className="transition-colors hover:text-foreground"
              >
                1000+ more
              </a>
            </li>
          </ul>
          {/* Radix Collapsible rather than the shadcn Accordion: the trigger
              here is one word sitting inline beside a link, not a full-width
              header with a chevron and a rule under it. */}
          <Collapsible className="mt-5 w-full max-w-lg">
            <div className="flex items-center justify-center gap-6 font-mono text-xs tracking-wide text-muted-foreground/70">
              <CollapsibleTrigger className="transition-colors hover:text-foreground data-[state=open]:text-foreground">
                Why?
              </CollapsibleTrigger>
              <a
                href="https://soapbox.pub/blog/how-to-self-host-armada"
                target="_blank"
                rel="noreferrer"
                className="underline decoration-muted-foreground/30 underline-offset-4 transition-colors hover:text-foreground hover:decoration-current"
              >
                Host your own
              </a>
            </div>
            {/* The height keyframes are landing-local: the shared
                `animate-accordion-*` utilities read the ACCORDION height
                variable, which a Collapsible never sets. */}
            <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-[armada-reveal-up_200ms_ease-out] data-[state=open]:animate-[armada-reveal-down_200ms_ease-out]">
              <p className="text-pretty px-2 pt-6 text-xs leading-relaxed text-muted-foreground sm:text-sm">
                Armada is built on{" "}
                <a
                  href="https://github.com/nostr-protocol/nostr"
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground underline decoration-muted-foreground/30 underline-offset-4 transition-colors hover:decoration-current"
                >
                  Nostr
                </a>
                , a social protocol which redefines the Internet. On Nostr,
                apps are separate from infra. Users sign events with
                private keys and distribute them across multiple public
                relays. Messages can be encrypted so even Nostr relays don't
                know what they say.
              </p>
            </CollapsibleContent>
          </Collapsible>
        </section>

        {/* ── The quiz ─────────────────────────────────────────────────── */}
        <EncryptionQuiz />

        {/* ── What else it does ────────────────────────────────────────── */}
        <section className="mx-auto flex min-h-[100svh] max-w-2xl flex-col items-center justify-center gap-6 px-6 py-16 text-center">
          <h2 className="text-balance font-mono text-xl font-bold tracking-tight text-foreground sm:text-3xl">
            We have voice and video too
          </h2>
          <p className="max-w-xl text-pretty text-sm leading-relaxed text-muted-foreground sm:text-base">
            Armada has everything you need to use it seriously. If not, you can
            always{" "}
            <a
              href="https://gitworkshop.dev/soapbox.pub/relay.ngit.dev/armada/issues"
              target="_blank"
              rel="noreferrer"
              className="text-foreground underline decoration-muted-foreground/30 underline-offset-4 transition-colors hover:decoration-current"
            >
              request a feature
            </a>{" "}
            or{" "}
            <a
              href="https://gitworkshop.dev/soapbox.pub/relay.ngit.dev/armada"
              target="_blank"
              rel="noreferrer"
              className="text-foreground underline decoration-muted-foreground/30 underline-offset-4 transition-colors hover:decoration-current"
            >
              hack it
            </a>{" "}
            too.
          </p>
          {/* Set in the body face, not mono: it reads as the paragraph's own
              next step rather than as another line of the caption strip. */}
          <a
            href="https://soapbox.pub/armada"
            target="_blank"
            rel="noreferrer"
            className="group inline-flex items-center gap-1.5 text-sm font-medium text-foreground/80 transition-colors hover:text-foreground sm:text-base"
          >
            Armada features
            {/* U+2192, for the reason the hero's ↓ is U+2193: WGL4 core, so
                every system font has a real glyph rather than tofu. */}
            <span
              aria-hidden="true"
              className="text-[hsl(var(--accent2)/0.75)] transition-transform group-hover:translate-x-0.5 group-hover:text-[hsl(var(--accent2))]"
            >
              &#8594;
            </span>
          </a>
        </section>

        {/* ── Platforms ────────────────────────────────────────────────────
            Where to take it. Names in the same mono caption strip as the
            relay lights: an enumeration of facts, subordinate to the heading,
            with the downloads page one arrow-link away. */}
        <section className="mx-auto flex min-h-[100svh] max-w-2xl flex-col items-center justify-center gap-6 px-6 py-16 text-center">
          <h2 className="text-balance font-mono text-xl font-bold tracking-tight text-foreground sm:text-3xl">
            The same Armada on every deck
          </h2>
          <p className="max-w-xl text-pretty text-sm leading-relaxed text-muted-foreground sm:text-base">
            Your key is your account, so the desktop app, the phone app and this
            browser are all the same place. Install it where you live.
          </p>
          <ul className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2.5 font-mono text-xs tracking-wide text-muted-foreground/70">
            <li>Linux</li>
            <li>Windows</li>
            <li>macOS</li>
            <li>Android</li>
            <li>iPhone &amp; iPad</li>
            <li>Web</li>
          </ul>
          {/* Body face, not mono, like the features link above: the
              paragraph's own next step rather than another caption line. */}
          <Link
            to="/downloads"
            className="group inline-flex items-center gap-1.5 text-sm font-medium text-foreground/80 transition-colors hover:text-foreground sm:text-base"
          >
            Get the apps
            {/* U+2192 again: WGL4 core, real glyph everywhere. */}
            <span
              aria-hidden="true"
              className="text-[hsl(var(--accent2)/0.75)] transition-transform group-hover:translate-x-0.5 group-hover:text-[hsl(var(--accent2))]"
            >
              &#8594;
            </span>
          </Link>
        </section>

        {/* ── The closer ───────────────────────────────────────────────────
            A screen of its own, bookending the hero: the same control over
            the same sea, with nothing else on it to read. */}
        <section className="mx-auto flex min-h-[100svh] max-w-xl flex-col items-center justify-center gap-8 px-6 py-16 text-center safe-area-bottom">
          {/* The sign-off returns to the hero's prompt: same cyan `$`, same
              magenta line, same blinking caret as {@link BrandMark}, so the
              page ends at the terminal it opened on. `armada-caret` comes from
              the crest's keyframes, already mounted below. */}
          <div className="flex flex-col items-center gap-2">
            <p className="text-balance text-sm text-muted-foreground sm:text-base">
              What are you waiting for?
            </p>
            <p className="font-mono text-xl text-[hsl(var(--primary))] sm:text-2xl">
              <span className="text-[hsl(var(--accent2,180_90%_55%))]">$ </span>
              sail the seas
              <span className="animate-[armada-caret_1s_step-end_infinite]">_</span>
            </p>
          </div>

          {/* The reader who scrolled the whole way shouldn't have to go back
              up to act on it. */}
          <div className="w-full max-w-sm">
            <Button
              size="lg"
              onClick={onJoin}
              className="h-12 w-full clip-corner-lg text-base font-medium"
            >
              Join
            </Button>
          </div>
        </section>

        {/* The floor of the page. Absolutely placed rather than appended in
            flow, so it darkens the last stretch of sea instead of adding a
            screenful of scroll after the CTA — reaching the bottom reads as
            arriving somewhere, not as running out of page. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-56 bg-gradient-to-b from-transparent via-black/45 to-black/90"
        />
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
function RelayLight({ url, index }: { url: string; index: number }) {
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
          state reads at a glance without out-shouting the muted caption.
          `currentColor` is the glow, so the color lives in one class.

          The two states blink like the two kinds of LED they're imitating: a
          live relay stutters like an activity light under load, a dead one
          keeps a slow fault beat. Each relay gets its own period and offset —
          a row blinking in lockstep reads as one animation rather than as
          four independent machines. */}
      <span
        aria-hidden="true"
        style={
          alive === undefined
            ? undefined
            : alive
              ? { animationDelay: `${index * 0.29}s`, animationDuration: `${1.15 + index * 0.13}s` }
              : { animationDelay: `${index * 0.11}s` }
        }
        className={cn(
          "size-1.5 shrink-0 rounded-full ring-2",
          alive === undefined && "animate-pulse bg-muted-foreground/40 ring-transparent motion-reduce:animate-none",
          alive === true &&
            "animate-[armada-led-busy_1.15s_steps(1,end)_infinite] bg-emerald-400 text-emerald-400/60 ring-emerald-400/20 motion-reduce:animate-none",
          alive === false &&
            "animate-[armada-led-fault_1.9s_steps(1,end)_infinite] bg-red-400 text-red-400/50 ring-red-400/15 motion-reduce:animate-none",
        )}
      />
      {/* The relay's own https origin — the same host the light just probed,
          so the link goes to the thing being vouched for. */}
      <a
        href={relayToHttpUrl(url)}
        target="_blank"
        rel="noreferrer"
        className="transition-colors hover:text-foreground"
      >
        {url.replace(/^wss:\/\//, "")}
      </a>
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
      /* The "Why?" reveal. Radix measures the panel and publishes its height
         on the content element, so the open/close is a real height animation
         rather than a guessed max-height. */
      @keyframes armada-reveal-down {
        from { height: 0; opacity: 0; }
        to   { height: var(--radix-collapsible-content-height); opacity: 1; }
      }
      @keyframes armada-reveal-up {
        from { height: var(--radix-collapsible-content-height); opacity: 1; }
        to   { height: 0; opacity: 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        [class*="animate-[armada-reveal"] { animation-duration: 1ms !important; }
      }

      /* A live relay's activity light: fast, uneven, mostly lit — traffic,
         not a heartbeat. Driven with steps(1,end) so every change is a hard
         switch; interpolating between stops would make it breathe instead of
         blink. Opacity + box-shadow only, so it never lays out. */
      @keyframes armada-led-busy {
        0%   { opacity: 1;   box-shadow: 0 0 5px 1px currentColor; }
        7%   { opacity: 0.2; box-shadow: none; }
        11%  { opacity: 1;   box-shadow: 0 0 5px 1px currentColor; }
        15%  { opacity: 0.2; box-shadow: none; }
        23%  { opacity: 1;   box-shadow: 0 0 5px 1px currentColor; }
        34%  { opacity: 0.2; box-shadow: none; }
        38%  { opacity: 1;   box-shadow: 0 0 5px 1px currentColor; }
        45%  { opacity: 0.2; box-shadow: none; }
        49%  { opacity: 1;   box-shadow: 0 0 5px 1px currentColor; }
        61%  { opacity: 0.2; box-shadow: none; }
        66%  { opacity: 1;   box-shadow: 0 0 5px 1px currentColor; }
        72%  { opacity: 0.2; box-shadow: none; }
        76%  { opacity: 1;   box-shadow: 0 0 5px 1px currentColor; }
        88%  { opacity: 0.2; box-shadow: none; }
        93%  { opacity: 1;   box-shadow: 0 0 5px 1px currentColor; }
      }

      /* A dead relay's fault light: one short pulse per cycle, same beat every
         time — the point is that it is NOT doing any work. */
      @keyframes armada-led-fault {
        0%   { opacity: 1;    box-shadow: 0 0 4px 0 currentColor; }
        22%  { opacity: 0.15; box-shadow: none; }
        100% { opacity: 0.15; box-shadow: none; }
      }

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
