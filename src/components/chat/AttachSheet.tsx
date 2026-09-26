import { Check, ChevronLeft, ChevronRight, EyeOff, ImageIcon, LayoutGrid, Loader2, Play, X } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { SHEET_NO_DRAG_ATTR, SHEET_SCROLL_ATTR, SnapSheet } from "@/components/chat/SnapSheet";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { useAndroidBack } from "@/hooks/useAndroidBack";
import { useLongPress } from "@/hooks/useLongPress";
import { formatTime } from "@/lib/formatTime";
import {
  checkMediaAccess,
  galleryItemSrc,
  galleryThumbnailSrc,
  hasMediaGallery,
  listRecentMedia,
  openMediaSettings,
  requestMediaAccess,
  type GalleryItem,
  type MediaAccess,
} from "@/lib/mediaGallery";
import { cn } from "@/lib/utils";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** One tile of the sheet's action row, and one row of the desktop "+" menu. */
export interface AttachAction {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  /** Shown highlighted (an armed poll). */
  active?: boolean;
  disabled?: boolean;
}

/** See MessageActionSheet: the opening tap's trailing event reads as an outside tap. */
const OPEN_GUARD_MS = 400;

/** How many gallery items one page fetches. */
const PAGE = 60;

/** How long a page may take before the grid offers a retry instead. */
const LIST_TIMEOUT_MS = 8000;

/** How far outside the grid's viewport a tile starts loading its thumbnail. */
const THUMB_PRELOAD_PX = 400;

interface AttachSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: AttachAction[];
  /**
   * In-chat apps (Watch together, …), gathered behind one "Apps" tile as
   * Discord does, on a page of their own with the game picker beneath them.
   */
  apps?: AttachAction[];
  /** The Mini App picker, shown on the Apps page. */
  gamePicker?: ReactNode;
  /**
   * The user picked these from the recent-media grid, in the order they
   * tapped them — all behind a spoiler when they asked for one.
   */
  onPickGalleryItems: (items: GalleryItem[], options: { spoiler: boolean }) => void;
}

/**
 * The touch "+" menu: a bottom sheet in the shape Signal and Discord use — the
 * camera roll first, multi-select with numbered picks, and a row of round
 * action tiles (gallery, camera, file, poll, …) beneath it.
 *
 * With the camera roll (Android, MediaGalleryPlugin) it is Discord's picker:
 * a sheet resting at keyboard height that a pull on the handle or the grid
 * expands to the full screen. Elsewhere the sheet is just the tiles, and
 * "Photos" opens the system picker, which on iOS is the photo library itself.
 */
export function AttachSheet(props: AttachSheetProps) {
  return hasMediaGallery() ? <GallerySheet {...props} /> : <TilesSheet {...props} />;
}

/** The action tiles plus, when there are apps, the tile that turns to them. */
function useTiles(actions: AttachAction[], apps: AttachAction[], gamePicker: ReactNode, openApps: () => void) {
  const hasApps = apps.length > 0 || gamePicker !== undefined;
  return hasApps
    ? [...actions, { id: "apps", label: "Apps", icon: LayoutGrid, onSelect: openApps }]
    : actions;
}

function GallerySheet({ open, onOpenChange, actions, apps = [], gamePicker, onPickGalleryItems }: AttachSheetProps) {
  const [page, setPage] = useState<"main" | "apps">("main");
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<GalleryItem[]>([]);
  const [preview, setPreview] = useState<GalleryItem | null>(null);
  const [spoiler, setSpoiler] = useState(false);

  const openApps = useCallback(() => {
    setPage("apps");
    setExpanded(true);
  }, []);
  const tiles = useTiles(actions, apps, gamePicker, openApps);

  // Back unwinds one layer at a time: the preview, the Apps page, the full
  // screen, and only then the sheet.
  useAndroidBack(() => {
    if (preview) setPreview(null);
    else if (page === "apps") {
      setPage("main");
      setExpanded(false);
    } else if (expanded) setExpanded(false);
    else onOpenChange(false);
    return true;
  }, open);

  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    // Always reopen at peek, on the main page, with nothing picked.
    if (!open) {
      setPage("main");
      setExpanded(false);
      setSelected([]);
      setPreview(null);
      setSpoiler(false);
    }
  }

  const toggle = useCallback((item: GalleryItem) => {
    setSelected((prev) =>
      prev.some((s) => s.id === item.id) ? prev.filter((s) => s.id !== item.id) : [...prev, item],
    );
  }, []);

  // Pulled down off the Apps page: that page only exists at full height.
  const onExpandedChange = useCallback((next: boolean) => {
    setExpanded(next);
    if (!next) setPage("main");
  }, []);

  // A preview is a full-screen view, so it takes the sheet there with it.
  const openPreview = useCallback((item: GalleryItem) => {
    setPreview(item);
    setExpanded(true);
  }, []);

  const pick = useCallback(() => {
    onOpenChange(false);
    onPickGalleryItems(selected, { spoiler });
  }, [onOpenChange, onPickGalleryItems, selected, spoiler]);

  // The footer floats pinned to the SCREEN bottom while the sheet moves: it
  // is counter-translated by the sheet's offset, and stays put at every
  // height. Its height is measured into a variable so the grid can scroll
  // its last row clear of it. The nodes are STATE, as in SnapSheet: the
  // sheet's Portal renders nothing on its first commit, so refs read by an
  // effect would still be null then and the effect would never run again.
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!body || !footer) return;
    const write = () => body.style.setProperty("--footer-h", `${footer.offsetHeight}px`);
    write();
    const ro = new ResizeObserver(write);
    ro.observe(footer);
    return () => ro.disconnect();
  }, [body, footer]);

  return (
    <SnapSheet
      open={open}
      onOpenChange={onOpenChange}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      title="Attach"
    >
      <SheetHeader
        title={page === "apps" ? "Apps" : undefined}
        onBack={page === "apps" ? () => { setPage("main"); setExpanded(false); } : undefined}
      />
      {page === "apps" ? (
        <AppsPage apps={apps} gamePicker={gamePicker} onOpenChange={onOpenChange} scrollable />
      ) : (
        <div ref={setBody} className="flex min-h-0 flex-1 flex-col">
          {open && (
            <RecentMediaGrid
              expanded={expanded}
              selected={selected}
              onToggle={toggle}
              onPreview={openPreview}
              onResetSelection={() => setSelected([])}
            />
          )}
          <div
            ref={setFooter}
            className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col gap-2 px-6 will-change-transform pb-[var(--safe-area-pad-bottom,0.75rem)]"
            style={{ transform: "translate3d(0, calc(-1 * var(--sheet-offset, 0px)), 0)" }}
          >
            {selected.length > 0 && (
              <div className="pointer-events-auto flex items-center gap-2 animate-in slide-in-from-bottom-2 fade-in-0 duration-150">
                <button
                  type="button"
                  onClick={() => setSelected([])}
                  className="h-11 clip-corner-lg bg-secondary px-4 text-sm font-medium"
                >
                  Clear
                </button>
                <button
                  type="button"
                  aria-pressed={spoiler}
                  aria-label="Mark as spoiler"
                  onClick={() => setSpoiler((s) => !s)}
                  className={cn(
                    "flex h-11 items-center gap-1.5 clip-corner-lg px-3 text-sm font-medium",
                    spoiler ? "bg-primary text-primary-foreground" : "bg-secondary",
                  )}
                >
                  <EyeOff className="size-4" />
                  Spoiler
                </button>
                <Button className="h-11 flex-1 clip-corner-lg font-semibold" onClick={pick}>
                  Add {selected.length} {selected.length === 1 ? "item" : "items"}
                </Button>
              </div>
            )}
            {/* A floating cut-corner panel over the grid, not a band glued
                to the sheet's bottom edge. clip-path cuts off a box-shadow,
                so the shadow is an unclipped box behind the panel — not a
                drop-shadow filter, which the Android WebView drops for a
                frame whenever the grid under it re-layers (a tile's
                selection transition). */}
            <div className="relative">
              <div aria-hidden className="absolute inset-0 rounded-[0.55rem] shadow-[0_6px_18px_rgba(0,0,0,0.5)]" />
              <div className="pointer-events-auto relative clip-corner-lg bg-chrome p-2">
                <Tiles tiles={tiles} onOpenChange={onOpenChange} cut />
              </div>
            </div>
          </div>
          {preview && (
            <GalleryPreview
              item={preview}
              order={orderOf(selected, preview)}
              onToggle={toggle}
              onClose={() => setPreview(null)}
            />
          )}
        </div>
      )}
    </SnapSheet>
  );
}

/**
 * The library moves under the pager: a photo taken while the sheet is open
 * pushes every item one place down, so the next offset-based page starts with
 * an item the grid already has. Keeping the first copy keeps the tile keys
 * unique and the grid from showing it twice.
 */
function appendPage(prev: GalleryItem[], page: GalleryItem[]): GalleryItem[] {
  const seen = new Set(prev.map((i) => i.id));
  const fresh = page.filter((i) => {
    if (seen.has(i.id)) return false;
    seen.add(i.id);
    return true;
  });
  return fresh.length === 0 ? prev : [...prev, ...fresh];
}

function dedupeById(items: GalleryItem[]): GalleryItem[] {
  return appendPage([], items);
}

function orderOf(selected: GalleryItem[], item: GalleryItem): number | undefined {
  const i = selected.findIndex((s) => s.id === item.id);
  return i === -1 ? undefined : i + 1;
}

/**
 * The sheet's top edge: the grab handle at every height (a drag or Android
 * back collapses it), plus a back button on the Apps page.
 */
function SheetHeader({ title, onBack }: { title?: string; onBack?: () => void }) {
  return (
    <div className="shrink-0">
      <div className="mx-auto mt-2.5 mb-2 h-1 w-9 rounded-full bg-muted-foreground/30" />
      {onBack && (
        <div className="flex items-center gap-1 px-2">
          <button
            type="button"
            aria-label="Back"
            onClick={onBack}
            className="flex size-11 items-center justify-center rounded-full text-muted-foreground active:bg-secondary"
          >
            <ChevronLeft className="size-5" />
          </button>
          <span className="flex-1 text-base font-semibold">{title}</span>
        </div>
      )}
    </div>
  );
}

function Tiles({ tiles, onOpenChange, className, cut }: {
  tiles: AttachAction[];
  onOpenChange: (open: boolean) => void;
  className?: string;
  /** Cut-corner squares, for the floating panel, instead of round tiles. */
  cut?: boolean;
}) {
  return (
    // The panel is always ONE row: its columns follow the tile count rather
    // than wrapping a fifth tile (an available poll) onto a second line.
    <div className={cn("grid shrink-0", cut ? "auto-cols-fr grid-flow-col gap-1" : "grid-cols-4 gap-y-3 px-3", className)}>
      {tiles.map((action) => (
        <button
          key={action.id}
          type="button"
          disabled={action.disabled}
          onClick={() => {
            // "Apps" turns the page; everything else leaves the sheet.
            if (action.id !== "apps") onOpenChange(false);
            action.onSelect();
          }}
          className={cn(
            "flex flex-col items-center gap-1.5 py-1 text-xs font-medium text-muted-foreground disabled:opacity-40 active:bg-secondary/60",
            cut ? "clip-corner-lg" : "rounded-xl",
          )}
        >
          <span
            className={cn(
              "flex items-center justify-center",
              cut ? "h-11 w-12 clip-corner-lg" : "size-14 rounded-full",
              action.active ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground",
            )}
          >
            <action.icon className="size-6" />
          </span>
          <span className="max-w-full truncate px-1">{action.label}</span>
        </button>
      ))}
    </div>
  );
}

function AppsPage({ apps, gamePicker, onOpenChange, scrollable }: {
  apps: AttachAction[];
  gamePicker?: ReactNode;
  onOpenChange: (open: boolean) => void;
  /** Inside the snap sheet, the drag hands off to this list. */
  scrollable?: boolean;
}) {
  return (
    <div
      className="flex min-h-0 flex-1 touch-pan-y flex-col overflow-y-auto overscroll-contain pb-[var(--safe-area-pad-bottom,0.75rem)]"
      {...(scrollable ? { [SHEET_SCROLL_ATTR]: "" } : { "data-vaul-no-drag": "" })}
    >
      {apps.length > 0 && (
        <div className="px-2 pb-1">
          {apps.map((app) => (
            <button
              key={app.id}
              type="button"
              disabled={app.disabled}
              onClick={() => {
                onOpenChange(false);
                app.onSelect();
              }}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[15px] font-medium active:bg-secondary disabled:opacity-40"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary">
                <app.icon className="size-5" />
              </span>
              <span className="flex-1">{app.label}</span>
              <ChevronRight className="size-4 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}
      {gamePicker && (
        <>
          <p className="px-5 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Games</p>
          <div className="shrink-0 px-1">{gamePicker}</div>
        </>
      )}
    </div>
  );
}

/** Without the camera roll (iOS, touch web): the tiles, in a plain sheet. */
function TilesSheet({ open, onOpenChange, actions, apps = [], gamePicker }: AttachSheetProps) {
  const [page, setPage] = useState<"main" | "apps">("main");
  const tiles = useTiles(actions, apps, gamePicker, () => setPage("apps"));

  useAndroidBack(() => {
    onOpenChange(false);
    return true;
  }, open);

  const openedAt = useRef(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) openedAt.current = Date.now();
    // Always reopen on the main page.
    else setPage("main");
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        className="max-h-[85dvh]"
        onPointerDownOutside={(e) => {
          if (Date.now() - openedAt.current < OPEN_GUARD_MS) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (Date.now() - openedAt.current < OPEN_GUARD_MS) e.preventDefault();
        }}
      >
        <DrawerTitle className="sr-only">Attach</DrawerTitle>
        {page === "apps" ? (
          <div className="flex min-h-0 flex-1 flex-col pt-1">
            <div className="flex shrink-0 items-center gap-1 px-2 pb-1">
              <button
                type="button"
                aria-label="Back"
                onClick={() => setPage("main")}
                className="flex size-11 items-center justify-center rounded-full text-muted-foreground active:bg-secondary"
              >
                <ChevronLeft className="size-5" />
              </button>
              <span className="text-base font-semibold">Apps</span>
            </div>
            <AppsPage apps={apps} gamePicker={gamePicker} onOpenChange={onOpenChange} />
          </div>
        ) : (
          <div className="pt-2 pb-[var(--safe-area-pad-bottom,0.75rem)]">
            <Tiles tiles={tiles} onOpenChange={onOpenChange} className="pt-3" />
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
}

/** The camera roll, newest first, with Signal-style numbered multi-select. */
function RecentMediaGrid({ expanded, selected, onToggle, onPreview, onResetSelection }: {
  expanded: boolean;
  selected: GalleryItem[];
  onToggle: (item: GalleryItem) => void;
  onPreview: (item: GalleryItem) => void;
  onResetSelection: () => void;
}) {
  const [access, setAccess] = useState<MediaAccess | "checking">("checking");
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const loadingRef = useRef(false);
  const resetRef = useRef(onResetSelection);
  resetRef.current = onResetSelection;

  const load = useCallback(async (offset: number) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      // A listing that never answers must not leave a blank grid forever.
      const page = await Promise.race([
        listRecentMedia(offset, PAGE),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), LIST_TIMEOUT_MS)),
      ]);
      setItems((prev) => (offset === 0 ? dedupeById(page.items) : appendPage(prev, page.items)));
      setMore(page.more);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void checkMediaAccess()
      .then((a) => {
        if (cancelled) return;
        setAccess(a);
        if (a === "full" || a === "limited") void load(0);
      })
      .catch(() => {
        if (!cancelled) setAccess("denied");
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  // Coming back from system settings (or a selection change made there):
  // re-read the grant, and the list if the grant changed.
  const accessRef = useRef(access);
  accessRef.current = access;
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void checkMediaAccess()
        .then((a) => {
          if (a === accessRef.current && a !== "limited") return;
          setAccess(a);
          if (a === "full" || a === "limited") {
            resetRef.current();
            void load(0);
          }
        })
        .catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  const ask = useCallback(async () => {
    try {
      const a = await requestMediaAccess();
      setAccess(a);
      if (a === "full" || a === "limited") {
        resetRef.current();
        await load(0);
      }
    } catch {
      // The request itself failed; the state shown is still the right one.
    }
  }, [load]);

  // Tiles ask for their native thumbnail only once they come within a few rows
  // of the viewport — each one is a plugin round-trip and a decode, and a
  // camera roll pages in by the hundred. One observer serves the whole grid.
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearRef = useRef<{ io: IntersectionObserver; root: Element | null; subs: Map<Element, () => void> } | null>(null);
  const observeNear = useCallback((el: Element, onNear: () => void) => {
    if (typeof IntersectionObserver === "undefined") {
      onNear();
      return () => {};
    }
    // The scroller unmounts behind a permission prompt; tiles mounted under a
    // new one need an observer rooted there.
    if (nearRef.current && nearRef.current.root !== scrollRef.current) {
      nearRef.current.io.disconnect();
      nearRef.current = null;
    }
    if (!nearRef.current) {
      const subs = new Map<Element, () => void>();
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const fire = subs.get(entry.target);
            subs.delete(entry.target);
            io.unobserve(entry.target);
            fire?.();
          }
        },
        { root: scrollRef.current, rootMargin: `${THUMB_PRELOAD_PX}px 0px` },
      );
      nearRef.current = { io, root: scrollRef.current, subs };
    }
    const near = nearRef.current;
    near.subs.set(el, onNear);
    near.io.observe(el);
    return () => {
      near.subs.delete(el);
      near.io.unobserve(el);
    };
  }, []);
  useEffect(() => () => {
    nearRef.current?.io.disconnect();
    nearRef.current = null;
  }, []);

  if (access === "checking") {
    return <div className="min-h-0 flex-1" />;
  }

  if (access === "prompt" || access === "denied") {
    // Top-aligned: the sheet is full height behind the peek, so a centred
    // prompt would sit under the tiles.
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center gap-2 px-8 pt-6 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-secondary">
          <ImageIcon className="size-6 text-muted-foreground" />
        </span>
        <p className="text-[15px] font-semibold">Share photos and videos</p>
        <p className="text-sm leading-snug text-muted-foreground">
          {access === "denied"
            ? "Photo access is turned off for Armada. Turn it on in settings to see your recent photos here."
            : "Let Armada show your recent photos and videos here."}
        </p>
        <Button
          size="sm"
          className="mt-2 rounded-full px-5 touch:h-11"
          onClick={() => void (access === "denied" ? openMediaSettings().catch(() => undefined) : ask())}
        >
          {access === "denied" ? "Open settings" : "Allow access"}
        </Button>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {access === "limited" && (
        <div className="flex shrink-0 items-center gap-3 px-4 pb-2">
          <p className="flex-1 text-[13px] leading-snug text-muted-foreground">
            Armada can only see the photos and videos you chose.
          </p>
          <Button size="sm" variant="secondary" className="h-8 shrink-0 rounded-full px-4 touch:h-11" onClick={() => void ask()}>
            Manage
          </Button>
        </div>
      )}
      <div
        ref={scrollRef}
        // At peek the sheet owns every vertical drag (a swipe up expands it),
        // so the browser may not pan; at full the grid scrolls natively and
        // the sheet takes over only when it is pulled down from the top.
        className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-1", expanded ? "touch-pan-y" : "touch-none")}
        {...{ [SHEET_SCROLL_ATTR]: "" }}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (more && !loading && el.scrollTop + el.clientHeight > el.scrollHeight - 400) void load(items.length);
        }}
      >
        {items.length === 0 ? (
          <div className="flex justify-center pt-10 text-sm text-muted-foreground">
            {loading ? (
              <Loader2 className="size-5 animate-spin" />
            ) : failed ? (
              <span className="flex flex-col items-center gap-2">
                Couldn't load your gallery.
                <Button size="sm" variant="secondary" className="rounded-full px-4 touch:h-11" onClick={() => void load(0)}>Retry</Button>
              </span>
            ) : (
              "No photos or videos yet."
            )}
          </div>
        ) : (
          // Bottom padding clears the selection bar that floats over the
          // grid once the sheet is full.
          <div className="grid grid-cols-3 gap-0.5 pb-[calc(var(--footer-h,6rem)+0.5rem)] sm:grid-cols-4">
            {items.map((item) => (
              <GalleryTile
                key={item.id}
                item={item}
                order={orderOf(selected, item)}
                onToggle={onToggle}
                onPreview={onPreview}
                observeNear={observeNear}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const GalleryTile = memo(function GalleryTile({ item, order, onToggle, onPreview, observeNear }: {
  item: GalleryItem;
  order?: number;
  onToggle: (item: GalleryItem) => void;
  onPreview: (item: GalleryItem) => void;
  /** Calls `onNear` once the element nears the viewport; returns the unsubscribe. */
  observeNear: (el: Element, onNear: () => void) => () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    return observeNear(el, () => setNear(true));
  }, [observeNear, near]);

  // Keyed by what the thumbnail depends on, so a reload that hands back an
  // equal item doesn't ask the plugin again, and an edited one does.
  const thumbKey = `${item.id}-${item.modified}`;
  const [thumb, setThumb] = useState<{ key: string; src: string } | null>(null);
  const loaded = thumb?.key === thumbKey;
  const itemRef = useRef(item);
  itemRef.current = item;
  useEffect(() => {
    if (!near || loaded) return;
    let cancelled = false;
    void galleryThumbnailSrc(itemRef.current)
      .then((src) => {
        if (!cancelled) setThumb({ key: thumbKey, src });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [near, loaded, thumbKey]);
  const src = thumb?.src;

  // Press and hold opens the full-size preview, as in Discord's picker.
  const press = useLongPress(() => onPreview(item), { allowInteractive: true });

  const picked = order !== undefined;
  return (
    <button
      ref={ref}
      type="button"
      aria-pressed={picked}
      aria-label={`${item.video ? "Video" : "Photo"}${item.name ? ` ${item.name}` : ""}`}
      {...press}
      onClick={(e) => {
        press.onClick(e);
        if (!e.defaultPrevented) onToggle(item);
      }}
      className="relative aspect-square select-none overflow-hidden bg-secondary/60 [-webkit-touch-callout:none]"
    >
      {src && (
        <img
          src={src}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          className={cn("size-full object-cover transition-transform duration-150", picked && "scale-90 rounded-lg")}
        />
      )}
      {item.video && (
        <span className="absolute bottom-1 left-1 flex items-center gap-0.5 rounded bg-black/60 px-1 py-px text-[10px] font-medium tabular-nums text-white">
          <Play className="size-2.5" fill="currentColor" />
          {item.duration > 0 ? formatTime(item.duration / 1000) : ""}
        </span>
      )}
      <SelectBadge order={order} className="absolute right-1.5 top-1.5" />
    </button>
  );
});

function SelectBadge({ order, className }: { order?: number; className?: string }) {
  const picked = order !== undefined;
  return (
    <span
      className={cn(
        "flex size-6 items-center justify-center rounded-full border-2 text-xs font-bold",
        picked ? "border-primary bg-primary text-primary-foreground" : "border-white/90 bg-black/20",
        className,
      )}
    >
      {picked ? (order <= 99 ? order : <Check className="size-3.5" />) : null}
    </span>
  );
}

/** The long-press preview: the item at full size, selectable from here too. */
function GalleryPreview({ item, order, onToggle, onClose }: {
  item: GalleryItem;
  order?: number;
  onToggle: (item: GalleryItem) => void;
  onClose: () => void;
}) {
  const src = galleryItemSrc(item);
  const picked = order !== undefined;
  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-black text-white animate-in fade-in-0 duration-150" {...{ [SHEET_NO_DRAG_ATTR]: "" }}>
      <div className="flex shrink-0 items-center justify-between px-2 pt-2">
        <button
          type="button"
          aria-label="Close preview"
          onClick={onClose}
          className="flex size-11 items-center justify-center rounded-full active:bg-white/10"
        >
          <X className="size-5" />
        </button>
        <button
          type="button"
          aria-pressed={picked}
          aria-label={picked ? "Deselect" : "Select"}
          onClick={() => onToggle(item)}
          className="flex size-11 items-center justify-center rounded-full active:bg-white/10"
        >
          <SelectBadge order={order} className="size-7" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        {item.video ? (
          <video src={src} controls autoPlay playsInline className="max-h-full max-w-full" />
        ) : (
          <img src={src} alt="" className="max-h-full max-w-full object-contain" />
        )}
      </div>
      <div className="flex shrink-0 justify-center px-4 pt-3 pb-[var(--safe-area-pad-bottom,0.75rem)]">
        <Button
          variant={picked ? "secondary" : "default"}
          className="h-11 w-full max-w-sm rounded-full font-semibold"
          onClick={() => {
            if (!picked) onToggle(item);
            onClose();
          }}
        >
          {picked ? "Done" : "Select"}
        </Button>
      </div>
    </div>
  );
}
