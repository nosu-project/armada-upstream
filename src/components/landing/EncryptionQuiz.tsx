import { useEffect, useRef, useState } from "react";

/**
 * The landing page's closing beat: a quiz you cannot read.
 *
 * The heading arrives as ciphertext and decodes left to right when the section
 * scrolls into view; the two answers never decode at all, churning hex for as
 * long as you look at them. Picking either one blows the whole quiz to dust and
 * uncovers the point, which was sitting behind it the entire time.
 */

const TITLE = "What are you talking about?";

/** The sentence the quiz was covering. */
const PUNCHLINE = "Messages on Armada are encrypted. Not even we know what you're talking about.";

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
    // A left-to-right sweep with enough jitter that no two neighbours leave
    // together — the gust crosses the quiz rather than lifting it whole.
    delay: `${i * 5 + rand(4) * 260}ms`,
  };
}

/**
 * Text that can be blown apart. Until then it renders as a plain string: one
 * span per character costs nothing while it sits still, but there is no reason
 * to pay for hundreds of them on every churn tick.
 */
function DustText({ text, dust, seed = 0 }: { text: string; dust: boolean; seed?: number }) {
  if (!dust) return <>{text}</>;
  return (
    <>
      {Array.from(text, (ch, i) => {
        const { dx, dy, rot, delay } = scatter(seed + i);
        return (
          <span
            key={i}
            className="inline-block animate-[armada-dust_900ms_ease-in_forwards] motion-reduce:animate-none"
            style={{ "--dust-dx": dx, "--dust-dy": dy, "--dust-rot": rot, animationDelay: delay } as React.CSSProperties}
          >
            {ch === " " ? "\u00a0" : ch}
          </span>
        );
      })}
    </>
  );
}

/**
 * The heading's text for the current frame: hex until `active`, then noise, then
 * a left-to-right decode. Reduced motion skips straight to the answer.
 */
function useDecodingTitle(active: boolean): string {
  const [text, setText] = useState(() => hex(TITLE.length));

  useEffect(() => {
    if (!active) return;
    if (prefersReducedMotion()) {
      setText(TITLE);
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
        setText(TITLE);
        clearInterval(id);
        return;
      }
      setText(TITLE.slice(0, decoded) + hex(TITLE.length - decoded));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [active]);

  return text;
}

/** A block of hex that reshuffles on an interval while `live`. */
function useHexBlock(live: boolean): string[] {
  const [rows, setRows] = useState(() => Array.from({ length: BLOCK_ROWS }, () => hex(BLOCK_COLS)));

  useEffect(() => {
    if (!live || prefersReducedMotion()) return;
    const id = setInterval(
      () => setRows(Array.from({ length: BLOCK_ROWS }, () => hex(BLOCK_COLS))),
      CHURN_MS,
    );
    return () => clearInterval(id);
  }, [live]);

  return rows;
}

/** One unreadable answer. */
function AnswerButton({
  label,
  seed,
  live,
  dust,
  onPick,
}: {
  /** What a screen reader gets, since the face of the button is noise. */
  label: string;
  seed: number;
  live: boolean;
  dust: boolean;
  onPick: () => void;
}) {
  const rows = useHexBlock(live);

  return (
    <button
      type="button"
      onClick={onPick}
      disabled={dust}
      aria-label={label}
      className="clip-corner-lg w-full border border-border/60 bg-background/40 px-4 py-6 font-mono text-[0.65rem] leading-relaxed text-muted-foreground/60 transition-colors hover:border-border hover:bg-background/70 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default sm:text-xs"
    >
      {rows.map((row, i) => (
        <span key={i} className="block break-all">
          <DustText text={row} dust={dust} seed={seed + i * BLOCK_COLS} />
        </span>
      ))}
    </button>
  );
}

export function EncryptionQuiz() {
  const sectionRef = useRef<HTMLElement>(null);
  const [revealed, setRevealed] = useState(false);
  const [picked, setPicked] = useState(false);
  const title = useDecodingTitle(revealed);

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
        className="mx-auto grid min-h-[100svh] max-w-3xl place-items-center px-6 py-16 safe-area-bottom"
      >
        {/* Both children share one grid cell: the punchline sits behind the
            quiz all along, so uncovering it costs no layout shift. */}
        <p
          className={`[grid-area:1/1] max-w-xl text-pretty text-center font-mono text-base font-bold leading-relaxed tracking-tight text-foreground transition-opacity duration-1000 sm:text-xl ${
            picked ? "opacity-100 delay-500" : "opacity-0"
          }`}
        >
          {PUNCHLINE}
        </p>

        <div
          className={`[grid-area:1/1] flex w-full flex-col items-center gap-8 ${picked ? "pointer-events-none" : ""}`}
        >
          {/* `nowrap` so the noise and the decoded question occupy exactly the
              same line — the heading resolves in place instead of reflowing. */}
          <h2 className="whitespace-nowrap font-mono text-lg font-bold tracking-tight text-foreground sm:text-3xl">
            <DustText text={title} dust={picked} />
          </h2>

          <div className="grid w-full grid-cols-2 gap-3 sm:gap-5">
            <AnswerButton
              label="First answer (encrypted)"
              seed={100}
              live={!picked}
              dust={picked}
              onPick={() => setPicked(true)}
            />
            <AnswerButton
              label="Second answer (encrypted)"
              seed={500}
              live={!picked}
              dust={picked}
              onPick={() => setPicked(true)}
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
