import {
  ArrowLeft,
  Check,
  KeyRound,
  Server,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { Button } from "@/components/ui/button";

/**
 * The About page: the TL;DR of where conversations live in Armada. Two choices,
 * not a long spectrum:
 *
 *   - Self-host a server (NIP-29 relay): you run the infrastructure, it hosts
 *     the channels and can read messages. Full control, the most work.
 *   - Decentralized encrypted chat (Concord): serverless and end-to-end
 *     encrypted. No host, nothing to set up, nobody can read it.
 *
 * Rendered as two flamboyant facing panels: cool/cyan = "your infrastructure",
 * warm/rose = "no host". Each has a breathing gradient border, a faint radial
 * colour wash bleeding in from its accent, a shimmering title, an icon, a
 * one-line who-can-read-it summary, and a few ticked traits. A glowing cyan→rose
 * seam runs between them (the spectrum lives in the gutter). Colours retint with
 * the active theme (the primary/accent2 pairing the crest uses for blade+wake).
 */

interface Option {
  icon: LucideIcon;
  /** "cool" = cyan/accent2 (self-host), "warm" = rose/primary (decentralized). */
  tone: "cool" | "warm";
  kicker: string;
  title: string;
  /** One-line who-can-read-it summary. */
  who: string;
  body: string;
  /** Ticked traits with their own glyphs. */
  traits: { icon: LucideIcon; text: string }[];
}

const OPTIONS: Option[] = [
  {
    icon: Server,
    tone: "cool",
    kicker: "Self-host",
    title: "Run a server",
    who: "You run it. The relay can read messages.",
    body:
      "A NIP-29 relay you host: it owns the channels and admits members. Full control of your own infrastructure, and the most to set up and keep running.",
    traits: [
      { icon: Wrench, text: "You run the infrastructure" },
      { icon: Server, text: "The host can read messages" },
      { icon: Check, text: "Full control over membership" },
    ],
  },
  {
    icon: ShieldCheck,
    tone: "warm",
    kicker: "Decentralized",
    title: "Encrypted chat",
    who: "No host. Only members can read it.",
    body:
      "A Concord chat: serverless and end-to-end encrypted. Nothing to set up and no host. Your key is your membership, and relays only ever store sealed blobs they can't read.",
    traits: [
      { icon: Sparkles, text: "Nothing to host or set up" },
      { icon: ShieldCheck, text: "End-to-end encrypted, even voice" },
      { icon: KeyRound, text: "Your key is your membership" },
    ],
  },
];

export function AboutPage() {
  const navigate = useNavigate();

  return (
    <main className="flex-1 min-w-0 flex flex-col safe-area-top">
      <header className="relative h-12 mx-2 mt-3 w-[calc(100%-1rem)] max-w-2xl sm:mx-auto px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
        <Button variant="ghost" size="icon" className="size-9 shrink-0" aria-label="Back" onClick={() => navigate(-1)}>
          <ArrowLeft className="size-5" />
        </Button>
        <h1 className="font-semibold truncate leading-tight">About</h1>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto safe-area-bottom">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 pb-16">
          <div className="space-y-8 pt-6">
            {/* Hero */}
            <section className="flex flex-col items-center gap-4 text-center">
              <ArmadaCrest size={104} />
              <div className="space-y-2">
                <p className="font-mono lowercase tracking-tight text-foreground text-lg">
                  a sovereign harbor on the open relays
                </p>
                <p className="text-sm text-muted-foreground leading-relaxed max-w-md">
                  Armada runs on{" "}
                  <a
                    href="https://nostr.com"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                  >
                    Nostr
                  </a>
                  , so your keys are your identity. There are two ways to talk,
                  and you pick per chat.
                </p>
              </div>
            </section>

            {/* The two choices */}
            <ChoiceCompare options={OPTIONS} />
          </div>
        </div>
      </div>

      <ArmadaCrestKeyframes />
      <AboutKeyframes />
    </main>
  );
}

/**
 * Two facing flamboyant panels split by a glowing cyan→rose seam (the spectrum
 * in the gutter): vertical seam on desktop, horizontal when stacked. Panels
 * rise in once on mount; the colour/glow is static after that (motion happens
 * on hover, not on a loop).
 */
function ChoiceCompare({ options }: { options: Option[] }) {
  return (
    <section className="relative grid gap-4 sm:grid-cols-2 sm:gap-5">
      {options.map((opt, i) => (
        <ChoicePanel key={opt.kicker} option={opt} delay={0.25 + i * 0.12} />
      ))}

      {/* The seam between the two panels: a glowing cyan→rose line with a
          flowing sheen, sitting in the gutter. Vertical on sm+, horizontal when
          stacked. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-8 top-1/2 -translate-y-1/2 h-px bg-[linear-gradient(90deg,transparent,hsl(var(--accent2,180_90%_55%)/0.8),hsl(var(--primary)/0.8),transparent)] sm:inset-x-auto sm:inset-y-8 sm:left-1/2 sm:top-auto sm:translate-y-0 sm:-translate-x-1/2 sm:h-auto sm:w-px sm:bg-[linear-gradient(180deg,transparent,hsl(var(--accent2,180_90%_55%)/0.8),hsl(var(--primary)/0.8),transparent)]"
      />
    </section>
  );
}

function ChoicePanel({ option, delay }: { option: Option; delay: number }) {
  const Icon = option.icon;
  const warm = option.tone === "warm";
  const accent = warm ? "text-primary" : "text-accent2";
  // The breathing gradient border + radial wash use the panel's own accent.
  const c = warm ? "hsl(var(--primary)" : "hsl(var(--accent2,180_90%_55%)";
  const c2 = warm ? "hsl(var(--accent2,180_90%_55%)" : "hsl(var(--primary)";
  return (
    <div
      className="group relative opacity-0 animate-[about-card-in_0.6s_ease-out_forwards]"
      style={{ animationDelay: `${delay}s` }}
    >
      {/* Static gradient frame behind the panel; brightens on hover. */}
      <div
        aria-hidden
        className="absolute -inset-px clip-corner-lg opacity-60 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background: `linear-gradient(135deg, ${c} / 0.9), ${c2} / 0.35), transparent 70%)`,
        }}
      />
      <div className="relative bg-chrome clip-corner-lg p-5 sm:p-6 flex flex-col gap-4 overflow-hidden transition-transform duration-300 group-hover:-translate-y-0.5">
        {/* Faint radial colour wash bleeding from the accent corner. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -right-10 -top-10 size-40 rounded-full blur-2xl opacity-25 transition-opacity duration-300 group-hover:opacity-45"
          style={{ background: `radial-gradient(circle, ${c} / 0.8), transparent 70%)` }}
        />

        <div className="relative flex items-center gap-3">
          <span
            className={`grid size-12 shrink-0 place-items-center rounded-xl bg-background/40 transition-transform duration-300 group-hover:scale-110 ${
              warm ? "neon-glow" : "wake-glow"
            }`}
          >
            <Icon className={`size-6 ${accent}`} />
          </span>
          <div className="min-w-0">
            <div className={`text-[11px] font-semibold uppercase tracking-[0.25em] ${warm ? "neon-text" : "wake-text"}`}>
              {option.kicker}
            </div>
            <h3
              className="text-xl font-bold leading-tight bg-clip-text text-transparent"
              style={{ backgroundImage: `linear-gradient(90deg, ${c}), ${c2}))` }}
            >
              {option.title}
            </h3>
          </div>
        </div>

        <p className="relative text-sm font-medium text-foreground leading-snug">{option.who}</p>
        <p className="relative text-sm text-muted-foreground leading-relaxed">{option.body}</p>

        <ul className="relative mt-1 space-y-2">
          {option.traits.map((t) => {
            const TraitIcon = t.icon;
            return (
              <li key={t.text} className="flex items-center gap-2.5 text-sm text-foreground/90">
                <span className={`grid size-6 shrink-0 place-items-center rounded-md bg-background/50 ${accent}`}>
                  <TraitIcon className="size-3.5" />
                </span>
                {t.text}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** Scoped keyframes for the About page's entrance motion. */
function AboutKeyframes() {
  return (
    <style>{`
      @keyframes about-card-in {
        from { opacity: 0; transform: translateY(14px) scale(0.985); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }
      @media (prefers-reduced-motion: reduce) {
        [class*="animate-[about-"] { animation: none !important; opacity: 1 !important; transform: none !important; }
      }
    `}</style>
  );
}
