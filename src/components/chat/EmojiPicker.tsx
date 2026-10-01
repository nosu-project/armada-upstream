import data from "@emoji-mart/data";
import { Picker } from "emoji-mart";
import { Compass } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useStableNavigate } from "@/hooks/useStableNavigate";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { recordReaction } from "@/hooks/useFrequentReactions";
import { syncEmojiMartCategories } from "@/lib/emojiMartCategories";

import type { CustomEmoji } from "@/hooks/useCustomEmojis";

export interface NativeEmojiSelection {
  type: "native";
  emoji: string;
}

export interface CustomEmojiSelection {
  type: "custom";
  shortcode: string;
  url: string;
}

export type EmojiSelection = NativeEmojiSelection | CustomEmojiSelection;

interface EmojiPickerProps {
  onSelect: (selection: EmojiSelection) => void;
  /** NIP-30 custom emojis to display in a dedicated tab. */
  customEmojis?: CustomEmoji[];
  /** Footer linking to Discover's emoji packs (opt-in; called before navigating). */
  onBrowsePacks?: () => void;
  /** The host has its own packs link; keep the footer only as the no-custom-emoji empty state. */
  packsLinkInHost?: boolean;
}

interface EmojiMartCustomEmoji {
  id: string;
  name: string;
  keywords: string[];
  skins: { src: string }[];
}

interface EmojiMartEmoji {
  id: string;
  native?: string;
  shortcodes?: string;
  unified?: string;
  src?: string;
}

/**
 * Manages the emoji-mart Picker web component imperatively: `@emoji-mart/react`
 * constructs it in an effect, which throws "Illegal constructor" on remount.
 */
export function EmojiPicker({ onSelect, customEmojis, onBrowsePacks, packsLinkInHost }: EmojiPickerProps) {
  const isMobile = useIsMobile();
  const { user } = useCurrentUser();
  const containerRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<InstanceType<typeof Picker> | null>(null);
  const onSelectRef = useRef(onSelect);

  onSelectRef.current = onSelect;

  const handleSelect = useCallback((emoji: EmojiMartEmoji) => {
    if (emoji.src) {
      recordReaction(user?.pubkey, `:${emoji.id}:`, emoji.src, emoji.id);
      onSelectRef.current({
        type: "custom",
        shortcode: emoji.id,
        url: emoji.src,
      });
    } else if (emoji.native) {
      recordReaction(user?.pubkey, emoji.native, undefined, emoji.id);
      onSelectRef.current({
        type: "native",
        emoji: emoji.native,
      });
    }
  }, [user?.pubkey]);

  // One custom category PER SOURCE PACK (like Discord per server); list-inlined
  // emojis go in a generic "Custom" group.
  const customCategories = useMemo(() => {
    if (!customEmojis || customEmojis.length === 0) return undefined;

    const groups = new Map<string, { id: string; name: string; emojis: EmojiMartCustomEmoji[] }>();
    for (const e of customEmojis) {
      const key = e.packCoord ?? "";
      let group = groups.get(key);
      if (!group) {
        groups.set(
          key,
          (group = {
            // Used for DOM ids, so keep a safe charset.
            id: key ? `custom-${key.replace(/[^a-zA-Z0-9]+/g, "-")}` : "custom-nostr",
            name: (key && e.packName) || "Custom",
            emojis: [],
          }),
        );
      }
      group.emojis.push({
        id: e.shortcode,
        name: e.shortcode,
        keywords: [e.shortcode],
        skins: [{ src: e.url }],
      });
    }

    // No per-category `icon`: each would get its own nav button and overflow the
    // single-row nav. Without one, packs share the first's nav entry.
    return [...groups.values()];
  }, [customEmojis]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const pickerOptions: Record<string, unknown> = {
      data,
      onEmojiSelect: handleSelect,
      theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
      previewPosition: "none",
      skinTonePosition: "search",
      set: "native",
      maxFrequentRows: 1,
      navPosition: "bottom",
      dynamicWidth: true,
      parent: container,
      autoFocus: !isMobile,
    };

    if (customCategories) {
      // Before the constructor: reconciles emoji-mart's global category table (see
      // syncEmojiMartCategories).
      syncEmojiMartCategories(customCategories);
      pickerOptions.custom = customCategories;
      pickerOptions.categories = [
        "frequent",
        ...customCategories.map((c) => c.id),
        "people",
        "nature",
        "foods",
        "activity",
        "places",
        "objects",
        "flags",
      ];
    }

    const picker = new Picker(pickerOptions);
    pickerRef.current = picker;

    // Shadow-DOM style overrides for sizing and theme.
    requestAnimationFrame(() => {
      const shadowRoot = (container.firstChild as HTMLElement)?.shadowRoot;
      if (shadowRoot) {
        const style = document.createElement("style");
        style.textContent = [
          ":host { width: 100% !important; height: 100% !important; min-height: 0 !important; border-radius: 0 !important; box-shadow: none !important; }",
          "#root { width: 100% !important; background-color: transparent !important; --sidebar-width: 0px !important; }",
          ".scroll { padding-right: var(--padding) !important; }",
          ".sticky { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; background-color: transparent !important; }",
          ".search input[type='search'] { background-color: hsl(var(--muted) / 0.5) !important; border: 0 !important; border-radius: 0.5rem !important; padding: 0.5rem 2rem 0.5rem 2.2rem !important; height: 36px !important; }",
          ".search input[type='search']:focus { box-shadow: 0 0 0 1px hsl(var(--ring)) !important; background-color: hsl(var(--background)) !important; }",
          ".search input[type='search']::placeholder { color: hsl(var(--muted-foreground)) !important; opacity: 1 !important; }",
          ".search .icon { color: hsl(var(--muted-foreground)) !important; }",
          "input { font-size: 16px !important; }",
          "#nav { flex-shrink: 0 !important; overflow: visible !important; }",
          "#nav svg, #nav img { overflow: visible !important; }",
          "#nav button { color: hsl(var(--muted-foreground)) !important; overflow: visible !important; }",
          "#nav button:hover { color: hsl(var(--foreground)) !important; }",
          "#nav button[aria-selected] { color: hsl(var(--primary)) !important; }",
          "#nav .bar { background-color: hsl(var(--primary)) !important; }",
          ".category button .background { background-color: hsl(var(--muted)) !important; }",
          ".scroll::-webkit-scrollbar { width: 6px !important; }",
          ".scroll::-webkit-scrollbar-thumb { background-color: transparent !important; border: 0 !important; border-radius: 9999px !important; }",
          ".scroll:hover::-webkit-scrollbar-thumb { background-color: hsl(var(--border)) !important; }",
          ".scroll::-webkit-scrollbar-track { background: transparent !important; }",
          ".sticky { color: hsl(var(--muted-foreground)) !important; font-size: 11px !important; text-transform: uppercase !important; letter-spacing: 0.05em !important; }",
          ".emoji-mart-emoji img[src] { width: 1em; height: 1em; object-fit: contain; }",
          // emoji-mart inlines its own stack, which lacks the bundled Twemoji fallback.
          ".emoji-mart-emoji > span { font-family: var(--emoji-fonts) !important; }",
        ].join(" ");
        shadowRoot.appendChild(style);
      }
    });

    return () => {
      pickerRef.current = null;
      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }
    };
  }, [handleSelect, customCategories, isMobile]);

  // Inside the fixed height: some hosts size to the picker and clip.
  return (
    <div className="flex w-full flex-col h-[min(360px,55dvh)] min-h-[220px] max-h-full">
      <div
        ref={containerRef}
        className="emoji-mart-wrapper flex w-full flex-1 min-h-0"
        style={{ isolation: "isolate" }}
        onWheel={(e) => {
          e.stopPropagation();
        }}
        onTouchMove={(e) => {
          e.stopPropagation();
        }}
      />
      {onBrowsePacks && !(packsLinkInHost && customEmojis?.length) && (
        <BrowsePacksFooter hasCustom={Boolean(customEmojis?.length)} onBrowse={onBrowsePacks} />
      )}
    </div>
  );
}

function BrowsePacksFooter({ hasCustom, onBrowse }: { hasCustom: boolean; onBrowse: () => void }) {
  const navigate = useStableNavigate();
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-3 py-1.5">
      <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {hasCustom ? "Find more emoji packs" : "Add custom emoji packs"}
      </div>
      <Button
        size="sm"
        variant="secondary"
        className="h-7 touch:h-11 shrink-0 rounded-lg px-2 text-xs"
        onClick={() => {
          onBrowse();
          navigate("/discover?tab=emojis");
        }}
      >
        <Compass className="size-3" />
        Browse
      </Button>
    </div>
  );
}
