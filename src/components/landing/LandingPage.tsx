import { HardDriveDownload } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { BrandMark } from "@/components/brand/BrandMark";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { RELAY_DICTIONARY } from "@/concord/lib/stockRelays";
import { ANDROID_STORES } from "@/lib/downloads";
import { relayToHttpUrl } from "@/lib/platform";
import { cn } from "@/lib/utils";

import { AsciiSea } from "./AsciiSea";
import { EncryptionQuiz } from "./EncryptionQuiz";
import { PitchToy } from "./PitchToy";
import { ProductShots } from "./ProductShots";
import { SailingSea } from "./SailingSea";

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

/** The closer's devices hold one community rather than cycling like the pitch's. */
const CLOSER_SHOT = ["raid-crew"];
const CLOSER_LABEL = "a gaming community's #general, with reactions, an inline reply and a thread";

/** True when the user has asked the OS to keep motion to a minimum. */
function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Memoized: its parent re-renders whenever the login dialog opens or closes,
 * and nothing on this page depends on that. Without it every Join tap
 * re-rendered the whole deck, quiz and relay lights included.
 */
export const LandingPage = memo(function LandingPage({
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
        {/* A quiet way to the downloads page in the top-right. `absolute`, not
            `fixed`: it sits at the top of the page and scrolls away with the
            hero rather than following the reader down the deck. `safe-area-top`
            drops it below a notch/status bar. Mono and lowercase to echo
            {@link BrandMark}; no frame, so it's a link rather than a CTA
            competing with Join. The cyan disk-download glyph — same `$`-prompt
            cyan as the sign-off — carries the accent instead of a border. */}
        <div className="absolute right-3 top-3 z-20 safe-area-top">
          <Link
            to="/downloads"
            className="inline-flex h-10 items-center gap-2 px-3 font-mono text-sm lowercase tracking-tight text-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <HardDriveDownload className="size-4 shrink-0 text-[hsl(var(--accent2,180_90%_55%))]" />
            get armada
          </Link>
        </div>

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

        {/* ── The pitch ──────────────────────────────────────────────────── */}
        <section
          className="flex min-h-[100svh] w-full flex-col items-center justify-center overflow-x-clip px-6 py-16"
        >
          <PitchToy />
        </section>

        {/* ── The quiz ─────────────────────────────────────────────────── */}
        <EncryptionQuiz />

        {/* ── The closer ───────────────────────────────────────────────────
            What it looks like, what it has, and the way in, in that order and
            in one section: the ask arrives with its reasons still on screen.
            One line of copy, the devices, the points, then Join. The stores
            and the outbound links come after the ask, quieter than it, so
            nothing on the screen competes with the one full-weight button.

            Extra space below lets the deck dissolve into the playable sea
            without putting text over its horizon. */}
        <section className="mx-auto flex min-h-[100svh] max-w-6xl flex-col items-center justify-center px-6 pb-56 pt-16 text-center">
          <h2 className="text-balance font-mono text-2xl font-bold tracking-tight text-foreground sm:text-4xl">
            Everything, on every deck
          </h2>
          <p className="mt-3 text-pretty text-sm text-muted-foreground sm:text-base">
            Desktop, phone or browser. Your key is your account on all of them.
          </p>

          <div className="mt-10 w-full">
            <ProductShots slugs={CLOSER_SHOT} index={0} label={CLOSER_LABEL} />
          </div>

          <FeaturePoints />

          {/* The sign-off returns to the hero's prompt: same cyan `$`, same
              magenta line, same blinking caret as {@link BrandMark}, so the
              deck returns to the terminal it opened on. `armada-caret` comes from
              the crest's keyframes, already mounted below. */}
          <div className="mt-16 flex w-full max-w-sm flex-col items-center gap-5">
            <p className="font-mono text-xl text-[hsl(var(--primary))] sm:text-2xl">
              <span className="text-[hsl(var(--accent2,180_90%_55%))]">$ </span>
              sail the seas
              <span className="animate-[armada-caret_1s_step-end_infinite]">_</span>
            </p>
            {/* The reader who scrolled the whole way shouldn't have to go back
                up to act on it. */}
            <Button
              size="lg"
              onClick={onJoin}
              className="h-12 w-full clip-corner-lg text-base font-medium"
            >
              Join
            </Button>
          </div>

          {/* The Android stores, as one quiet row under the ask: a visitor
              scans for their store's mark and needs no frame to find it. */}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-sm text-muted-foreground">
            {ANDROID_STORES.map((store) => (
              <a
                key={store.url}
                href={store.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-10 items-center gap-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring touch:h-11"
              >
                {/* An <img> of the store's own mark: it is the thing being
                    scanned for, and neither logo is ours to redraw. */}
                <img src={store.icon} alt="" className="size-4 shrink-0" />
                {store.label}
              </a>
            ))}
          </div>

          {/* The stores above are Android's; this says where else it runs,
              since a visitor on a desktop otherwise has no idea there is an
              app for them. The prompt echoes the sign-off above. */}
          <p className="mt-2 text-balance font-mono text-xs tracking-wide text-muted-foreground sm:text-sm">
            <span className="text-[hsl(var(--accent2,180_90%_55%))]">$ </span>
            also on macOS, Linux &amp; Windows{" "}
            <span className="whitespace-nowrap">
            <span aria-hidden="true" className="text-muted-foreground/50">
              ·
            </span>{" "}
            <Link
              to="/downloads"
              className="text-foreground/90 underline decoration-muted-foreground/30 underline-offset-4 transition-colors hover:text-foreground hover:decoration-current"
            >
              all downloads
            </Link>
            </span>
          </p>

          {/* Everything outbound, in the caption register the relay strip
              uses: last, and smallest. */}
          <div className="mt-6 flex items-center justify-center gap-6 font-mono text-xs tracking-wide text-muted-foreground/60">
            <a
              href="https://soapbox.pub/armada"
              target="_blank"
              rel="noreferrer"
              className="transition-colors hover:text-foreground"
            >
              more about armada
            </a>
            <a
              href="https://gitworkshop.dev/soapbox.pub/relay.ngit.dev/armada"
              target="_blank"
              rel="noreferrer"
              className="transition-colors hover:text-foreground"
            >
              source code
            </a>
          </div>
        </section>

        <SailingSea />
      </div>

      <ArmadaCrestKeyframes />
      <LandingKeyframes />
    </>
  );
});

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
            "animate-[armada-led-busy_1.15s_steps(1,end)_infinite] bg-emerald-400 text-emerald-400/60 ring-emerald-400/20 shadow-[0_0_5px_1px_currentColor] motion-reduce:animate-none",
          alive === false &&
            "animate-[armada-led-fault_1.9s_steps(1,end)_infinite] bg-red-400 text-red-400/50 ring-red-400/15 shadow-[0_0_4px_0_currentColor] motion-reduce:animate-none",
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

/**
 * What Armada has, at a glance: four points, one row, in the caption register.
 * The devices above already show the chat; these are the things a screenshot
 * can't, with games first because nothing else in the category has them.
 */
const FEATURES = ["Multiplayer games & mini apps", "Voice & video calls", "Discord import", "No phone or email"];

/**
 * The points, each behind a small gilt diamond (a rotated square rather than a
 * glyph, so no font can render it as tofu).
 */
function FeaturePoints() {
  return (
    <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-8 gap-y-2 font-mono text-xs tracking-wide text-muted-foreground sm:text-sm">
      {FEATURES.map((feature) => (
        <li key={feature} className="flex items-center gap-2.5">
          <span aria-hidden="true" className="size-1.5 shrink-0 rotate-45 bg-amber-300/90" />
          {feature}
        </li>
      ))}
    </ul>
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
         blink. OPACITY ONLY — the glow is a static shadow on the element that
         dims with it. Animating box-shadow ran on the main thread, and four
         of these restyled the landing page on every frame, forever. */
      @keyframes armada-led-busy {
        0%   { opacity: 1; }
        7%   { opacity: 0.2; }
        11%  { opacity: 1; }
        15%  { opacity: 0.2; }
        23%  { opacity: 1; }
        34%  { opacity: 0.2; }
        38%  { opacity: 1; }
        45%  { opacity: 0.2; }
        49%  { opacity: 1; }
        61%  { opacity: 0.2; }
        66%  { opacity: 1; }
        72%  { opacity: 0.2; }
        76%  { opacity: 1; }
        88%  { opacity: 0.2; }
        93%  { opacity: 1; }
      }

      /* A dead relay's fault light: one short pulse per cycle, same beat every
         time — the point is that it is NOT doing any work. Opacity only, like
         the busy light. */
      @keyframes armada-led-fault {
        0%   { opacity: 1; }
        22%  { opacity: 0.15; }
        100% { opacity: 0.15; }
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
