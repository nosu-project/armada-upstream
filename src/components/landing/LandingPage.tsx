import { useEffect, useRef, useState, type ReactNode } from "react";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { BrandMark } from "@/components/brand/BrandMark";
import { Button } from "@/components/ui/button";

import { AsciiLogo } from "./AsciiLogo";
import { AsciiSea } from "./AsciiSea";

/**
 * The signed-out landing page: a scrolling deck over the {@link AsciiSea}.
 *
 * The sea is viewport-locked and the content scrolls over it. Sections are
 * chamfered panels floating on the water, blurred so the character grid reads
 * as water seen through glass rather than text behind a box.
 *
 * This deck is also the answer to "how does Armada work?", which is why the
 * hero's secondary action scrolls into it rather than routing away.
 */

/** Scroll cadence for the section reveals, in ms. */
const REVEAL_MS = 620;

/** The Concord protocol specs (CORD-01..07). */
const CONCORD_SPEC_URL = "https://github.com/concord-protocol/concord";
/** Intro to Nostr, for the "what even is a key" reader. */
const NOSTR_101_URL = "https://soapbox.pub/blog/nostr101";
/** Operator guide for running your own relay + voice stack. */
const SELF_HOST_URL = "https://soapbox.pub/blog/how-to-self-host-armada";
/** Armada's source, a Nostr git repo, browsable on gitworkshop. */
const SOURCE_URL = "https://gitworkshop.dev/soapbox.pub/armada";
/** Signed Android builds. */
const ZAPSTORE_URL = "https://zapstore.dev/apps/buzz.armada.app";
/** The shop that builds Armada. */
const SOAPBOX_URL = "https://soapbox.pub";

/** True when the user has asked the OS to keep motion to a minimum. */
function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Reveals its children once they scroll into view.
 *
 * Opacity and transform only, no `filter`: a blur-in would repaint the whole
 * subtree every frame, on top of a character grid that is already redrawing.
 * Fires once, or scrolling back up becomes a slideshow.
 */
function Reveal({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion()) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setShown(true);
        io.disconnect();
      },
      // Wait until the panel is properly on screen, not just clipping the
      // bottom edge, or every section is already "revealed" by the time the
      // user has scrolled far enough to look at it.
      { rootMargin: "0px 0px -12% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      style={{
        transitionDuration: `${REVEAL_MS}ms`,
        // Expo-out, the crest's own "sweep" curve. Inline because an arbitrary
        // cubic-bezier in a Tailwind easing utility is ambiguous between
        // transition- and animation-timing-function, and warns at build time.
        transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
        opacity: shown ? 1 : 0,
        transform: shown ? "translateY(0)" : "translateY(0.75rem)",
      }}
      className="transition-[opacity,transform] motion-reduce:transition-none"
    >
      {children}
    </div>
  );
}

/**
 * An outbound link, set as a terminal command: the same `$` prompt idiom as
 * the wordmark, so a link off the deck reads as something you run rather than
 * a button. `noreferrer` on every one, because this is a privacy app and the
 * destination has no business knowing which page sent you.
 */
function DeckLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="group mt-3.5 inline-flex items-baseline gap-2 font-mono text-sm text-[hsl(var(--accent2))] transition-colors hover:text-foreground"
    >
      <span aria-hidden="true" className="text-[hsl(var(--accent2)/0.7)]">
        $
      </span>
      <span className="underline decoration-[hsl(var(--accent2)/0.35)] underline-offset-4 group-hover:decoration-current">
        {children}
      </span>
      <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">
        &rarr;
      </span>
    </a>
  );
}

/**
 * One deck panel: a borderless, deeply chamfered hull floating on the water.
 *
 * `--cut` deepens `.clip-corner-lg`'s 0.7rem chamfer. Set inline, not as a
 * Tailwind arbitrary property: both are single-class specificity, so the
 * winner is decided by stylesheet order, and a reshuffle would silently
 * flatten the corners with no build error.
 */
function Section({
  title,
  mark,
  children,
}: {
  title: string;
  /** Optional ASCII emblem, floated opposite the heading. */
  mark?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Reveal>
      <section className="mx-auto w-full max-w-2xl px-5 py-4 sm:px-6 sm:py-5">
        <div
          style={{ "--cut": "2.25rem" } as React.CSSProperties}
          className="clip-corner-lg bg-[hsl(var(--chrome-deep)/0.55)] p-6 backdrop-blur-md sm:p-8"
        >
          <div className="flex items-start justify-between gap-4">
            <h2 className="min-w-0 font-mono text-xl font-bold lowercase tracking-tight text-foreground sm:text-2xl">
              {title}
            </h2>
            {mark}
          </div>
          <div className="mt-3 space-y-2.5 text-sm leading-relaxed text-muted-foreground">
            {children}
          </div>
        </div>
      </section>
    </Reveal>
  );
}

export function LandingPage({
  onJoin,
  scrollRef,
}: {
  /** Opens the login dialog, the canonical logged-out CTA. */
  onJoin: () => void;
  scrollRef: React.RefObject<HTMLElement | null>;
}) {
  const deckRef = useRef<HTMLDivElement>(null);

  // "How does Armada work?" is answered by the deck below, so it scrolls
  // there instead of routing away to a separate page.
  const scrollToDeck = () => {
    deckRef.current?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "start",
    });
  };

  return (
    <>
      {/*
        Viewport-locked sea. `sticky` pins it while `-mb-[100svh]` cancels the
        height it would otherwise add to the scroll length, so the deck below
        starts at the top of the page and scrolls straight over it.
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
            {/* Question and scroll cue are one control: the deck IS the
                answer, so a detached arrow read as a second affordance. */}
            <button
              type="button"
              onClick={scrollToDeck}
              className="group mt-5 flex w-full flex-col items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              How does Armada work?
              {/* Not `font-mono`: U+2B9F is outside most monospace faces, so
                  the UI stack is likelier to have a real glyph. */}
              <span
                aria-hidden="true"
                className="animate-[armada-bob_2.4s_ease-in-out_infinite] text-sm leading-none text-[hsl(var(--accent2)/0.75)] group-hover:text-[hsl(var(--accent2))]"
              >
                &#11167;
              </span>
            </button>
          </div>
        </section>

        {/* ── The deck ─────────────────────────────────────────────────── */}
        <div ref={deckRef} className="pt-2">
          <Section title="no host required" mark={<AsciiLogo name="concord" />}>
            <p>
              Every group chat you have used has a computer in the middle. It
              holds every message, knows every member, and decides who can do
              what. It can be subpoenaed, hacked, sold, or switched off, and
              when it is, your community goes with it.
            </p>
            <p>
              Concord deletes that computer. Relays carry sealed blobs and
              nothing else. If you can decrypt the room, you are in it. Who is
              in charge is a signed list every member checks for themselves.
            </p>
            <DeckLink href={CONCORD_SPEC_URL}>read the concord specs</DeckLink>
          </Section>

          <Section title="your keys, your fleet" mark={<AsciiLogo name="nostr" />}>
            <p>
              Your identity is a secret key that lives on your device. No email,
              no phone number, no password to forget and no account to be locked
              out of.
            </p>
            <p>
              Save it to your password manager and sign in anywhere by bringing
              the key. Nobody can reset it for you, and nobody can take it from
              you. It works across every app on Nostr, not just this one.
            </p>
            <DeckLink href={NOSTR_101_URL}>new to nostr? start here</DeckLink>
          </Section>

          <Section title="run your own" mark={<AsciiLogo name="soapbox" />}>
            <p>
              Prefer a server you control? Host the whole thing yourself:
              messages, voice and notifications.
            </p>
            <p>
              Nothing is baked into the app. Every address is one you supply, so
              a fresh install starts empty and points wherever you tell it to.
            </p>
            <DeckLink href={SELF_HOST_URL}>how to self-host armada</DeckLink>
          </Section>

          <Section title="get the app" mark={<AsciiLogo name="zapstore" />}>
            <p>
              Signed Android builds are published to Zapstore, where each
              release is checked against the developer's own key rather than a
              store account.
            </p>
            <DeckLink href={ZAPSTORE_URL}>get armada on zapstore</DeckLink>
          </Section>

          <Section title="read the source" mark={<AsciiLogo name="ngit" />}>
            <p>
              Armada is free software, developed in the open. No telemetry, no
              accounts, and no server you have to trust us to run honestly.
              Check it yourself.
            </p>
            <DeckLink href={SOURCE_URL}>browse the repository</DeckLink>
          </Section>
        </div>

        {/* ── Closing CTA ──────────────────────────────────────────────── */}
        <Reveal>
          <section className="mx-auto flex w-full max-w-xl flex-col items-center gap-5 px-6 pb-6 pt-8 text-center">
            <p className="font-mono text-xl font-bold lowercase tracking-tight text-foreground sm:text-2xl">
              ready to come aboard?
            </p>
            <Button
              size="lg"
              onClick={onJoin}
              className="h-12 w-full max-w-sm clip-corner-lg text-base font-medium"
            >
              Join
            </Button>
          </section>
        </Reveal>

        {/* ── Colophon ─────────────────────────────────────────────────── */}
        <Reveal>
          {/* The Soapbox mark itself sits on the self-host panel, so the
              colophon stays text to avoid printing it twice. */}
          <footer className="mx-auto flex w-full max-w-xl justify-center px-6 pb-12 pt-6 text-center safe-area-bottom">
            <a
              href={SOAPBOX_URL}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              built by soapbox
            </a>
          </footer>
        </Reveal>
      </div>

      <ArmadaCrestKeyframes />
      <LandingKeyframes />
    </>
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
