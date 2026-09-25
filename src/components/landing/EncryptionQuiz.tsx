import { memo, useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import { ConcordGrid, ConcordMark, ConcordReveal } from "./ConcordReveal";

/**
 * The landing page's closing beat: a quiz you cannot read.
 *
 * The heading arrives as ciphertext and decodes left to right when the section
 * scrolls into view; the two answers never decode at all, churning hex for as
 * long as you look at them. Picking either one blows the whole quiz to dust and
 * uncovers the point, which was sitting behind it the entire time.
 */

const TITLE = "What are you talking about?";

/**
 * The sentence the quiz was covering. Broken after the first sentence by hand:
 * the claim and its consequence get a line each, rather than whatever split the
 * container width happens to produce.
 */
const PUNCHLINE = [
  "Messages on Armada are encrypted.",
  "Not even we know what you're talking about.",
];

/** Rows and columns of hex in each answer button. */
const BLOCK_ROWS = 5;
const BLOCK_COLS = 18;

/** Ciphertext churn — slow enough to read as data, fast enough to feel alive. */
const CHURN_MS = 110;

/** How long the heading is pure noise before any of it decodes. */
const GARBLE_MS = 1100;
/** How long the decode itself takes, first character to last. */
const DECODE_MS = 1300;
/** Frame interval for the heading's noise. */
const TICK_MS = 45;

const HEX = "0123456789abcdef";

/** A run of `n` random hex characters. Decorative, so `Math.random` is fine. */
function hex(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += HEX[(Math.random() * 16) | 0];
  return out;
}

/** True when the user has asked the OS to keep motion to a minimum. */
function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Where character `i` goes when the quiz is blown apart. Derived from the index
 * by hash rather than drawn from `Math.random`, so a re-render mid-flight can't
 * reshuffle a character that is already moving.
 *
 * Direction only, deliberately: every character leaves on the same frame, and
 * what makes it read as dust rather than a fade is that they all leave on
 * different headings. Staggering the starts instead put the title, the left
 * answer and the right answer on visibly separate clocks.
 */
function scatter(i: number) {
  const rand = (salt: number) => {
    const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  return {
    dx: `${(rand(1) - 0.3) * 130}px`,
    dy: `${-40 - rand(2) * 110}px`,
    rot: `${(rand(3) - 0.5) * 200}deg`,
  };
}

/**
 * Text that can be blown apart. Until then it renders as a plain string: one
 * span per character costs nothing while it sits still, but there is no reason
 * to pay for hundreds of them on every churn tick.
 */
function DustText({
  text,
  dust,
  seed = 0,
}: {
  text: string;
  dust: boolean;
  seed?: number;
}) {
  if (!dust) return <>{text}</>;
  return (
    <>
      {Array.from(text, (ch, i) => {
        const { dx, dy, rot } = scatter(seed + i);
        return (
          <span
            key={i}
            className="inline-block animate-[armada-dust_900ms_ease-in_forwards] motion-reduce:animate-none"
            style={
              {
                "--dust-dx": dx,
                "--dust-dy": dy,
                "--dust-rot": rot,
              } as React.CSSProperties
            }
          >
            {ch === " " ? "\u00a0" : ch}
          </span>
        );
      })}
    </>
  );
}

/**
 * Decode the heading in place: noise until `active`, then a left-to-right
 * decode. Reduced motion skips straight to the answer.
 *
 * Written straight into `ref`'s text rather than through state: at a 45ms tick
 * a state-driven decode re-rendered the quiz ~50 times for one entrance. React
 * renders the element's initial noise once and never touches its text again,
 * so the two never disagree about what is in the node.
 */
function useDecodingTitle(
  ref: React.RefObject<HTMLElement | null>,
  active: boolean,
) {
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    if (prefersReducedMotion()) {
      el.textContent = TITLE;
      return;
    }
    const start = performance.now();
    const id = setInterval(() => {
      const elapsed = performance.now() - start;
      const decoded =
        elapsed <= GARBLE_MS
          ? 0
          : Math.round(((elapsed - GARBLE_MS) / DECODE_MS) * TITLE.length);
      if (decoded >= TITLE.length) {
        el.textContent = TITLE;
        clearInterval(id);
        return;
      }
      el.textContent = TITLE.slice(0, decoded) + hex(TITLE.length - decoded);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [ref, active]);
}

/**
 * Whether `ref`'s element is in the viewport of a visible page. The ciphertext
 * churn rewrites both answer blocks ~9 times a second, which is a steady
 * main-thread cost for decoration nobody can see once the quiz has scrolled
 * away or the tab is in the background — so it only runs while this is true.
 */
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [intersecting, setIntersecting] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) =>
      setIntersecting(entry.isIntersecting),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  useEffect(() => {
    const onChange = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  return intersecting && pageVisible;
}

/** An answer card's pose; `--r` is the turn, set per card and eased on hover. */
const answerPose = (z: number) => `perspective(1100px) rotateY(var(--r)) translateZ(${-z}px)`;
const ANSWER_FACE = { transform: answerPose(0) } as React.CSSProperties;
/** The body: flat layers stepping back behind the face, lighter toward the front. */
const ANSWER_BODY = Array.from({ length: 10 }, (_, j) => {
  const t = j / 9;
  return { transform: answerPose(22 * (1 - t) + 1), background: `hsl(262 10% ${5 + t * 9}%)` } as React.CSSProperties;
});
const ANSWER_SCANLINES = {
  backgroundImage: "repeating-linear-gradient(to bottom, rgba(0,0,0,0.32) 0 1px, transparent 1px 3px)",
} as React.CSSProperties;

/**
 * One unreadable answer. The hex reshuffles by writing each row's text node
 * directly while `live`, not through state, so the churn costs no renders at
 * all. React only renders the block again when it turns to dust, and then
 * swaps the rows for keyed dust spans rather than editing text it no longer
 * owns. The dust is the mount-time block: it is random noise either way, and
 * at a 110ms churn nobody can tell which random block it was.
 */
const AnswerButton = memo(function AnswerButton({
  label,
  letter,
  seed,
  live,
  dust,
  onPick,
}: {
  /** What a screen reader gets, since the face of the button is noise. */
  label: string;
  /** The answer's tag, the one part of it that isn't encrypted. */
  letter: string;
  seed: number;
  live: boolean;
  dust: boolean;
  onPick: () => void;
}) {
  const [rows] = useState(() =>
    Array.from({ length: BLOCK_ROWS }, () => hex(BLOCK_COLS)),
  );
  const rowEls = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    if (!live || prefersReducedMotion()) return;
    const id = setInterval(() => {
      for (const el of rowEls.current) if (el) el.textContent = hex(BLOCK_COLS);
    }, CHURN_MS);
    return () => clearInterval(id);
  }, [live]);

  // Posed like the pitch's screens: two faces of one shape angled away from
  // each other, each a flat panel under its own perspective with a stack of
  // layers behind it for a body. A flat panel rather than preserve-3d keeps
  // the text sharp, and a real border rather than the chamfer's clip-path
  // keeps the turned edge anti-aliased. Hover swings the card toward you.
  const outward = letter === "a" ? -1 : 1;
  // Each card floats on its own clock, so the pair never bobs in step.
  const pose = {
    "--ry": `${outward * 18}deg`,
    "--ry-hover": `${outward * 6}deg`,
    animationDelay: outward < 0 ? "0s" : "-3.2s",
  } as React.CSSProperties;

  return (
    <div
      className={cn(
        "group/ans relative animate-[armada-ans-float_6.5s_ease-in-out_infinite] [--r:var(--ry)] hover:[--r:var(--ry-hover)] has-[:focus-visible]:[--r:var(--ry-hover)] motion-reduce:animate-none",
        (!live || dust) && "[animation-play-state:paused]",
      )}
      style={pose}
    >
      {ANSWER_BODY.map((shade, j) => (
        <div
          key={j}
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 rounded-[18px] transition-[transform,opacity] duration-700 ease-out",
            dust && "opacity-0 duration-300",
          )}
          style={shade}
        />
      ))}
      <button
        type="button"
        onClick={onPick}
        disabled={dust}
        aria-label={label}
        style={ANSWER_FACE}
        className={cn(
          "relative block w-full rounded-[18px] bg-[#0c0a10] p-2 text-left font-mono text-[0.62rem] leading-relaxed text-muted-foreground/80 ring-1 ring-white/[0.07] transition-[transform,color,box-shadow,background-color] duration-700 ease-out hover:text-foreground/90 hover:ring-[hsl(var(--primary)/0.5)] focus-visible:outline-none focus-visible:ring-ring disabled:cursor-default sm:p-3 sm:text-xs",
          // The set goes first, and fast, so the dust has nothing behind it.
          dust && "bg-transparent ring-transparent duration-300 hover:ring-transparent",
        )}
      >
        <span
          className={cn(
            "relative block overflow-hidden rounded-[10px] bg-black px-3 pb-6 pt-11 transition-colors duration-300 sm:px-5",
            dust && "bg-transparent",
          )}
        >
          {!dust && <span aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-60" style={ANSWER_SCANLINES} />}
          {/* The one plaintext on the card: which answer it is. */}
          <span
            aria-hidden="true"
            className={cn(
              "absolute left-3 top-3 grid size-6 place-items-center rounded-sm border border-[hsl(var(--accent2)/0.5)] text-xs font-bold uppercase text-[hsl(var(--accent2,180_90%_55%))] transition-opacity duration-300 sm:left-5 sm:text-sm",
              dust && "opacity-0",
            )}
          >
            {letter}
          </span>
          <span
            aria-hidden="true"
            className={cn(
              "absolute right-3 top-4 text-[0.6rem] uppercase tracking-[0.2em] text-muted-foreground/50 transition-opacity duration-300 sm:right-5",
              dust && "opacity-0",
            )}
          >
            sealed
          </span>
          {/* A read head passing over the ciphertext and getting nothing. */}
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-0 top-0 h-10 animate-[armada-read-head_4.5s_ease-in-out_infinite] bg-gradient-to-b from-transparent via-[hsl(var(--accent2)/0.12)] to-transparent motion-reduce:hidden",
              !live && "[animation-play-state:paused]",
              dust && "opacity-0",
            )}
            style={{ animationDelay: `${-seed / 200}s` }}
          />
        {rows.map((row, i) =>
          dust ? (
            <span key={`dust-${i}`} className="block break-all">
              <DustText text={row} dust seed={seed + i * BLOCK_COLS} />
            </span>
          ) : (
            <span
              key={`live-${i}`}
              ref={(el) => {
                rowEls.current[i] = el;
              }}
              className="block break-all"
            >
              {row}
            </span>
          ),
        )}
        </span>
      </button>
    </div>
  );
});

export function EncryptionQuiz() {
  const sectionRef = useRef<HTMLElement>(null);
  const [revealed, setRevealed] = useState(false);
  const [picked, setPicked] = useState(false);
  const titleRef = useRef<HTMLSpanElement>(null);
  // Initial noise only; the decode writes the rest straight into the node.
  const [titleNoise] = useState(() => hex(TITLE.length));
  useDecodingTitle(titleRef, revealed && !picked);
  const onScreen = useOnScreen(sectionRef);
  // Stable, so the memoized answers don't re-render with their parent.
  const pick = useCallback(() => setPicked(true), []);

  // The decode is the section's entrance, so it waits for the section to be
  // looked at rather than for the page to mount — and runs once, not on every
  // pass back through the viewport.
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setRevealed(true);
        observer.disconnect();
      },
      { threshold: 0.35 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <section
        ref={sectionRef}
        className="relative grid min-h-[100svh] w-full place-items-center overflow-hidden px-6 py-16"
      >
        {/* Both children share one grid cell: the punchline sits behind the
            quiz all along, so uncovering it costs no layout shift. */}
        <ConcordGrid shown={picked} />

        {/* The claim, then the protocol that makes it true, each arriving a
            beat after the last. `inert` until the pick, so the link can't be
            tabbed to through the quiz. */}
        <div
          inert={!picked}
          className="[grid-area:1/1] relative flex max-w-4xl flex-col items-center gap-8 text-center font-mono"
        >
          <ConcordMark shown={picked} />
          {/* The claim in the foreground colour, its consequence in the
              primary accent: the second line is the one the quiz was for. */}
          <p
            className={cn(
              "text-balance text-xl font-bold leading-snug tracking-tight transition-opacity duration-1000 sm:text-2xl lg:text-3xl",
              picked ? "opacity-100 delay-500" : "opacity-0",
            )}
          >
            <span className="text-foreground">{PUNCHLINE[0]}</span>
            <br />
            <span className="text-[hsl(var(--primary))]">{PUNCHLINE[1]}</span>
          </p>

          <ConcordReveal shown={picked} />
        </div>

        <div
          className={`[grid-area:1/1] flex w-full max-w-3xl flex-col items-center gap-8 ${picked ? "pointer-events-none" : ""}`}
        >
          {/* `nowrap` so the noise and the decoded question occupy exactly the
              same line — the heading resolves in place instead of reflowing. */}
          <h2 className="whitespace-nowrap font-mono text-xl font-bold tracking-tight text-foreground sm:text-4xl lg:text-5xl">
            {/* Keyed swap rather than a text change: the live span's text is
                written outside React, so React must remove the element, not
                edit a text node it no longer tracks. A pick mid-decode blows
                away the answer, which is all but decoded by then anyway. */}
            {picked ? (
              <span key="dust">
                <DustText text={TITLE} dust />
              </span>
            ) : (
              <span key="live" ref={titleRef}>
                {titleNoise}
              </span>
            )}
          </h2>

          {/* The one line of the quiz you can read, so it reads as a question
              with answers rather than two boxes of noise. Mono caption register,
              the same as the landing's other labels. */}
          <p
            className={cn(
              "-mt-4 font-mono text-xs tracking-wide text-muted-foreground/70 transition-opacity duration-300",
              picked && "opacity-0",
            )}
          >
            // pick one
          </p>

          <div className="grid w-full grid-cols-2 gap-4 sm:gap-10">
            <AnswerButton
              label="First answer (encrypted)"
              letter="a"
              seed={100}
              live={!picked && onScreen}
              dust={picked}
              onPick={pick}
            />
            <AnswerButton
              label="Second answer (encrypted)"
              letter="b"
              seed={500}
              live={!picked && onScreen}
              dust={picked}
              onPick={pick}
            />
          </div>
        </div>
      </section>

      <EncryptionQuizKeyframes />
    </>
  );
}

/** Quiz-only keyframes, scoped the way the landing page's others are. */
function EncryptionQuizKeyframes() {
  return (
    <style>{`
      /* A character caught by the gust: carried up and away, spinning out of
         focus as it goes. Transform, filter and opacity only — no layout. */
      @keyframes armada-ans-float {
        0%, 100% { transform: translateY(0); }
        50%      { transform: translateY(-10px); }
      }
      @keyframes armada-read-head {
        0%   { transform: translateY(-100%); }
        60%, 100% { transform: translateY(1400%); }
      }
      @keyframes armada-dust {
        from {
          opacity: 1;
          transform: translate3d(0, 0, 0) rotate(0deg);
          filter: blur(0);
        }
        to {
          opacity: 0;
          transform: translate3d(var(--dust-dx), var(--dust-dy), 0) rotate(var(--dust-rot));
          filter: blur(6px);
        }
      }
    `}</style>
  );
}
