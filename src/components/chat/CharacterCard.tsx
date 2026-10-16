import { Capacitor } from "@capacitor/core";
import { ChevronRight, Download, IdCard, Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { Lightbox, type LightboxItem } from "@/components/chat/Lightbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChromeDialogContent, ChromeDialogFooter, ChromeDialogHeader, Dialog } from "@/components/ui/dialog";
import { useBlossomCandidates } from "@/hooks/useBlossomCandidates";
import { useMediaWithFallback } from "@/hooks/useMediaWithFallback";
import { toast } from "@/hooks/useToast";
import type { CharaCard, CharacterCardRef } from "@/lib/characterCard";
import { downloadBinaryFile } from "@/lib/downloadFile";
import {
  decryptBuffer,
  fetchCapped,
  MAX_EXPLICIT_DECRYPT_BYTES,
  verifyPlaintextHash,
} from "@/lib/encryptedMedia";
import { safeFilename } from "@/lib/fileBytes";
import { cn } from "@/lib/utils";

/** The card PNG as a decorative image; the id-card glyph until it resolves (or if it fails). */
function CharacterCardArt({
  image,
  imgClassName,
  iconClassName,
  onArtClick,
}: {
  image: CharacterCardRef;
  imgClassName: string;
  iconClassName: string;
  /** Given, a resolved image offers the full-size preview; the fallback glyph doesn't. */
  onArtClick?: () => void;
}) {
  const { resolved, onError, failed } = useMediaWithFallback(image);
  if (failed || resolved.status !== "ready") return <IdCard className={iconClassName} />;
  const img = (
    <img
      src={resolved.src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={onError}
      draggable={false}
      className={imgClassName}
    />
  );
  if (!onArtClick) return img;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onArtClick();
      }}
      aria-label="View artwork full size"
      title="View full size"
      className="block max-w-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      {img}
    </button>
  );
}

/** Cards write `{{char}}` placeholders into their prose; preview with the name filled in. */
function substituteChar(text: string, name: string): string {
  return text.replaceAll("{{char}}", name).replaceAll("{{Char}}", name);
}

/** One titled card field; empty fields don't render. Long bodies scroll inside their box. */
function CardSection({ title, text }: { title: string; text?: string }) {
  if (!text?.trim()) return null;
  return (
    <section className="space-y-1">
      <h3 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      <p className="max-h-44 overflow-y-auto whitespace-pre-wrap break-words clip-corner bg-secondary/30 px-3 py-2 text-sm leading-relaxed text-foreground/90">
        {text}
      </p>
    </section>
  );
}

function useCardDownload(card: CharaCard, image: CharacterCardRef) {
  // Deliberate open: fetched directly (never through the passive-display proxy).
  const candidates = useBlossomCandidates(image.url, image.fallbacks);
  const [busy, setBusy] = useState(false);
  const encryption = image.encryption;

  const download = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // The sender's PNG itself is the portable card (bytes carry the payload).
      const raw = await fetchCapped(candidates, { maxBytes: MAX_EXPLICIT_DECRYPT_BYTES });
      const bytes = encryption
        ? new Uint8Array(await decryptBuffer(raw, encryption.key, encryption.nonce))
        : new Uint8Array(raw);
      if (encryption) await verifyPlaintextHash(bytes, encryption.ox);
      await downloadBinaryFile(`${safeFilename(card.name)}.png`, bytes);
      if (Capacitor.isNativePlatform()) {
        toast({ title: "Saved", description: "You'll find it in the Armada folder in Files." });
      }
    } catch {
      toast({ title: "Download failed", description: card.name, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }, [busy, candidates, encryption, card.name]);

  return { download, busy };
}

const SPEC_LABELS: Record<CharaCard["spec"], string> = {
  v1: "Spec v1",
  v2: "Spec v2",
  v3: "Spec v3",
};

const NOOP_NAV = () => { /* single image: nothing to navigate to */ };

function CharacterCardDialog({ card, image, onClose }: { card: CharaCard; image: CharacterCardRef; onClose: () => void }) {
  const { download, busy } = useCardDownload(card, image);
  const text = (value: string | undefined) => (value ? substituteChar(value, card.name) : undefined);
  const creator = card.creator?.trim();
  const description = [
    SPEC_LABELS[card.spec],
    creator ? `by ${creator}` : undefined,
    card.character_version ? `version ${card.character_version}` : undefined,
  ].filter(Boolean).join(" · ");
  const book = card.character_book;

  // Full-size art preview. Close requests aimed at the dialog (Esc / outside
  // pointer-down both fire from below the lightbox) are ignored while it is
  // up, so only the lightbox closes.
  const [viewArt, setViewArt] = useState(false);
  const closeArt = useCallback(() => setViewArt(false), []);
  const { url, mime, encryption, fallbacks } = image;
  const artMedia = useMemo<LightboxItem[]>(
    () => [{ url, mime, encryption, fallbacks }],
    [url, mime, encryption, fallbacks],
  );

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !viewArt) onClose(); }}>
      <ChromeDialogContent title={`Character card: ${card.name}`} className="sm:max-w-xl">
        <ChromeDialogHeader icon={IdCard} title={<span className="normal-case">{card.name}</span>} description={description} />

        <div className="mt-4 flex justify-center">
          <CharacterCardArt
            image={image}
            imgClassName="max-h-52 rounded-lg object-contain transition-opacity hover:opacity-90"
            iconClassName="size-10 text-muted-foreground/40"
            onArtClick={() => setViewArt(true)}
          />
        </div>

        {viewArt && (
          <Lightbox
            media={artMedia}
            currentIndex={0}
            onClose={closeArt}
            onNext={NOOP_NAV}
            onPrev={NOOP_NAV}
            // z above dialogs (z-250), and pointer-events re-enabled: the modal
            // dialog sets `pointer-events: none` on body, which the portaled
            // lightbox would otherwise inherit with dead buttons.
            className="z-[300] pointer-events-auto"
          />
        )}

        {card.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {card.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="text-2xs font-medium">{tag}</Badge>
            ))}
          </div>
        )}

        <div className="mt-4 space-y-3 min-w-0">
          <CardSection title="Description" text={text(card.description)} />
          <CardSection title="Personality" text={text(card.personality)} />
          <CardSection title="Scenario" text={text(card.scenario)} />
          <CardSection title="First message" text={text(card.first_mes)} />

          {card.alternate_greetings.length > 0 && (
            <section className="space-y-1">
              <h3 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Alternate greetings · {card.alternate_greetings.length}
              </h3>
              <ol className="space-y-1.5">
                {card.alternate_greetings.map((greeting, i) => (
                  <li
                    key={i}
                    className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words clip-corner bg-secondary/30 px-3 py-2 text-sm leading-relaxed text-foreground/90"
                  >
                    <span className="mr-1.5 text-xs text-muted-foreground tabular-nums">{i + 1}.</span>
                    {substituteChar(greeting, card.name)}
                  </li>
                ))}
              </ol>
            </section>
          )}

          <CardSection title="Example messages" text={text(card.mes_example)} />
          <CardSection title="System prompt" text={text(card.system_prompt)} />
          <CardSection title="Post-history instructions" text={text(card.post_history_instructions)} />
          <CardSection title="Creator notes" text={card.creator_notes} />

          {book && book.entries.length > 0 && (
            <section className="space-y-1">
              <h3 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Character book · {book.entries.length} {book.entries.length === 1 ? "entry" : "entries"}
              </h3>
              <ul className="space-y-1.5">
                {book.entries.slice(0, 10).map((entry, i) => (
                  <li key={i} className="clip-corner bg-secondary/30 px-3 py-2">
                    <p className="truncate text-xs font-medium text-foreground">
                      {entry.name || entry.keys.join(", ") || `Entry ${i + 1}`}
                      {!entry.enabled && <span className="ml-1.5 text-muted-foreground">(disabled)</span>}
                    </p>
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground line-clamp-3">
                      {substituteChar(entry.content, card.name)}
                    </p>
                  </li>
                ))}
              </ul>
              {book.entries.length > 10 && (
                <p className="text-xs text-muted-foreground">…and {book.entries.length - 10} more in the download.</p>
              )}
            </section>
          )}
        </div>

        <ChromeDialogFooter className="mt-5">
          <Button type="button" onClick={() => void download()} disabled={busy} className="gap-2">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            Download card
          </Button>
        </ChromeDialogFooter>
      </ChromeDialogContent>
    </Dialog>
  );
}

/**
 * The footer row of an in-chat character card: names the card and opens the
 * full explorer. The parent frames it under the card's art; pass `open` /
 * `onOpenChange` when the art should open the same explorer.
 */
export function CharacterCardEmbed({
  card,
  image,
  open: openProp,
  onOpenChange,
  className,
}: {
  card: CharaCard;
  image: CharacterCardRef;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChange ?? setOpenState;
  const creator = card.creator?.trim();

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        aria-label={`View character card: ${card.name}`}
        className={cn(
          "group flex w-full items-center gap-2.5 px-3 py-2 text-left",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
          className,
        )}
      >
        <IdCard className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold leading-tight">{card.name}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            Character card{creator ? ` · by ${creator}` : ""}
          </span>
        </span>
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary"
          aria-hidden
        />
      </button>
      {open && <CharacterCardDialog card={card} image={image} onClose={() => setOpen(false)} />}
    </>
  );
}
