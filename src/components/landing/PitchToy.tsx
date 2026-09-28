import { RefreshCw } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { TvDrum } from "./TvDrum";

/**
 * "Armada is a group chat for your ___": the word types itself to match the
 * rotating prism's community; tapping nudges it. Typing writes the text node
 * directly (no per-character renders).
 */

/** Word plus its capture (`e2e/landing-screenshots.spec.ts`). */
const CREWS = [
  { word: "raid crew", slug: "raid-crew", label: "a gaming community's #general, with reactions, an inline reply and a thread" },
  { word: "book club", slug: "book-club", label: "a book club's #general, with a vote, reactions and a thread" },
  { word: "band", slug: "band", label: "a band's #general, planning a show" },
  { word: "dev team", slug: "dev-team", label: "a dev team's #general, fixing a crash in a thread" },
  { word: "family", slug: "family", label: "a family's #general, planning a Sunday call" },
] as const;

const TYPE_MS = 55;

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export const PitchToy = memo(function PitchToy() {
  const [step, setStep] = useState(0);
  const [index, setIndex] = useState(0);
  const wordRef = useRef<HTMLSpanElement>(null);

  const tune = useCallback((delta: number) => setStep((s) => s + delta), []);
  const next = useCallback(() => tune(1), [tune]);

  useEffect(() => {
    const el = wordRef.current;
    if (!el) return;
    const word = CREWS[index].word;
    if (prefersReducedMotion()) {
      el.textContent = word;
      return;
    }
    let n = 0;
    el.textContent = "";
    const id = setInterval(() => {
      n++;
      el.textContent = word.slice(0, n);
      if (n >= word.length) clearInterval(id);
    }, TYPE_MS);
    return () => clearInterval(id);
  }, [index]);

  return (
    <div className="flex w-full flex-col items-center">
      <h2 className="text-center font-mono text-3xl font-bold tracking-tight text-foreground sm:text-5xl">
        <span className="sr-only">Armada is a group chat for your communities.</span>
        <span aria-hidden="true">Armada is a group chat for your</span>
      </h2>
      <button
        type="button"
        onClick={next}
        aria-label="Show another kind of community"
        className="group mt-2 inline-flex min-h-[2.75rem] items-center gap-3 font-mono text-3xl font-bold tracking-tight text-[hsl(var(--primary))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:min-h-[3.75rem] sm:text-5xl"
      >
        <span aria-hidden="true">
          <span ref={wordRef} />
          <span className="animate-[armada-caret_1s_step-end_infinite]">_</span>
        </span>
        <RefreshCw
          aria-hidden="true"
          className="size-5 shrink-0 text-[hsl(var(--accent2)/0.5)] transition-[color,transform] duration-300 group-hover:rotate-90 group-hover:text-[hsl(var(--accent2))] sm:size-6"
        />
      </button>

      <div className="mt-10 w-full">
        <TvDrum channels={CREWS} step={step} onTune={tune} onFront={setIndex} />
      </div>

      <p className="mt-10 text-balance text-center font-mono text-xs tracking-wide text-muted-foreground sm:text-sm">
        Channels, voice and games. Encrypted, and nobody owns the server.
      </p>
    </div>
  );
});
