import { encode as blurhashEncode } from "blurhash";
import {
  ArrowUpRight,
  BarChart3,
  Loader2,
  Mic,
  Paperclip,
  Plus,
  Reply,
  Smile,
  Square,
  Sticker,
  X,
} from "lucide-react";
import { nip19 } from "nostr-tools";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EmbeddedNaddr, EmbeddedNote } from "@/components/chat/EmbeddedNote";
import { EmojiShortcodeAutocomplete } from "@/components/chat/EmojiShortcodeAutocomplete";
import { GifPicker } from "@/components/chat/GifPicker";
import { MentionAutocomplete } from "@/components/chat/MentionAutocomplete";
import { SlashCommandAutocomplete } from "@/components/chat/SlashCommandAutocomplete";
import { StickerPicker } from "@/components/chat/StickerPicker";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCustomEmojis } from "@/hooks/useCustomEmojis";
import { useGroup } from "@/hooks/useGroup";
import { useInsertText } from "@/hooks/useInsertText";
import { useMentionInsertions } from "@/hooks/useMentionBus";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { useToast } from "@/hooks/useToast";
import { useUploadFile } from "@/hooks/useUploadFile";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { formatTime } from "@/lib/formatTime";
import { extractHashtags } from "@/lib/hashtag";
import { IMETA_MEDIA_URL_REGEX, IMETA_MEDIA_URL_TEST_REGEX, mimeFromExt } from "@/lib/mediaUrls";
import { KIND_GROUP_CHAT, relayRejectionMessage } from "@/lib/nip29";
import { resizeImage } from "@/lib/resizeImage";
import { parseSlashCommand, resolveNpubArg, type SlashAction, type SlashCommand } from "@/lib/slashCommands";
import { cn } from "@/lib/utils";

import type { AddrCoords } from "@/hooks/useEvent";
import type { NostrEvent } from "@nostrify/nostrify";

/** Lazy-loaded EmojiPicker — keeps emoji-mart + its data out of the main bundle. */
const LazyEmojiPicker = lazy(() => import("@/components/chat/EmojiPicker").then((m) => ({ default: m.EmojiPicker })));

/** NIP-88 poll kind. */
const KIND_POLL = 1068;

const MAX_CHARS = 2000;

/** MIME types accepted via paste/drag-and-drop (matches the file picker). */
const ACCEPTED_PASTE_RE = /^(image|video|audio)\//;

/** Short random ID for poll options. */
function pollOptionId(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** A per-channel composer draft persisted in localStorage. */
interface Draft {
  content: string;
  /** Uploaded attachments as [url, NIP-94 tags] entries (Blossom URLs). */
  attachments: [string, string[][]][];
}

/**
 * Read a channel draft. Tolerates the legacy plain-string format (older builds
 * stored just the text) by treating a non-JSON value as the content.
 */
function readDraft(key: string): Draft {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { content: "", attachments: [] };
    if (raw[0] === "{") {
      const parsed = JSON.parse(raw) as Partial<Draft>;
      return {
        content: typeof parsed.content === "string" ? parsed.content : "",
        attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
      };
    }
    return { content: raw, attachments: [] };
  } catch {
    return { content: "", attachments: [] };
  }
}

/** Write or clear a channel draft. Clears when there's nothing worth keeping. */
function writeDraft(key: string, content: string, attachments: Map<string, string[][]>): void {
  try {
    if (content.trim() || attachments.size > 0) {
      localStorage.setItem(key, JSON.stringify({ content, attachments: [...attachments] }));
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // localStorage might be full or unavailable.
  }
}

/**
 * For an image File, returns `{ dim: "WxH", blurhash: "..." }`.
 * Decodes to a small canvas (max 64px wide) for speed.
 */
async function getImageMeta(file: File): Promise<{ dim?: string; blurhash?: string }> {
  if (!file.type.startsWith("image/")) return {};
  try {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = url;
      });

      const naturalWidth = img.naturalWidth;
      const naturalHeight = img.naturalHeight;
      if (!naturalWidth || !naturalHeight) return {};

      const dim = `${naturalWidth}x${naturalHeight}`;

      const SAMPLE_W = 64;
      const scale = SAMPLE_W / naturalWidth;
      const sampleH = Math.max(1, Math.round(naturalHeight * scale));

      const canvas = document.createElement("canvas");
      canvas.width = SAMPLE_W;
      canvas.height = sampleH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return { dim };

      ctx.drawImage(img, 0, 0, SAMPLE_W, sampleH);
      const { data } = ctx.getImageData(0, 0, SAMPLE_W, sampleH);

      const blurhash = blurhashEncode(data, SAMPLE_W, sampleH, 4, 3);
      return { dim, blurhash };
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return {};
  }
}

/** An embed (quote or link) detected in the composer content. */
interface DetectedEmbed {
  type: "nevent" | "note" | "naddr";
  value: string;
  index: number;
  eventId?: string;
  relay?: string;
  author?: string;
  addr?: AddrCoords;
}

interface ChatComposerProps {
  relayUrl: string;
  groupId: string;
  /** Current timeline (used for NIP-29 `previous` refs). */
  messages: NostrEvent[];
  /** Message being replied to, if any. */
  replyTo?: NostrEvent;
  onCancelReply?: () => void;
  /** Called after a message is successfully sent. */
  onSent?: () => void;
  /**
   * When provided, the composer sends via this callback (with the final text,
   * including any appended attachment URLs) instead of publishing a NIP-29
   * kind-9 group message. Used by DMs, where the whole content is encrypted
   * and NIP-29 group tagging / polls don't apply. Poll mode is hidden in this
   * mode. The returned promise resolving means "sent" (composer is reset).
   */
  sendOverride?: (finalText: string) => Promise<void>;
  /** Placeholder text for the input (defaults to the group placeholder). */
  placeholder?: string;
  /**
   * Extra key fragment to scope the per-channel localStorage draft. Use a
   * distinct value (e.g. a thread root id) when more than one composer targets
   * the same group so their drafts don't collide.
   */
  draftScope?: string;
  /**
   * Optimistic-send hooks (group mode). When provided, an outgoing message is
   * inserted into the timeline as `pending` the moment it's signed, then
   * confirmed (`onSent` of the publish) or marked failed for retry.
   */
  onOptimisticInsert?: (event: NostrEvent) => void;
  onOptimisticSent?: (id: string) => void;
  onOptimisticFailed?: (id: string) => void;
  /** Whether the current user can moderate (enables moderation slash commands). */
  canModerate?: boolean;
  /** Focus the textarea on mount (e.g. when a thread panel opens). */
  autoFocus?: boolean;
  /**
   * Run a slash-command moderation action (e.g. /kick, /ban). Delegated to the
   * caller, which owns the NIP-29 moderation mutations and member roster.
   */
  onSlashAction?: (action: SlashAction) => void | Promise<void>;
}

/**
 * Rich chat composer for NIP-29 groups: multi-line textarea with @-mention
 * and :shortcode: autocomplete, emoji/GIF/sticker pickers, media uploads with
 * NIP-92 imeta tags, paste-to-upload, voice messages, NIP-88 polls, replies,
 * NIP-18 quotes, and per-channel drafts.
 *
 * With `sendOverride` it doubles as a generic rich composer (e.g. DMs): the
 * same input/upload/picker UX, but sending is delegated to the caller and
 * group-only features (polls, NIP-29 tagging) are disabled.
 */
export function ChatComposer({ relayUrl, groupId, messages, replyTo, onCancelReply, onSent, sendOverride, placeholder, draftScope, onOptimisticInsert, onOptimisticSent, onOptimisticFailed, canModerate = false, autoFocus = false, onSlashAction }: ChatComposerProps) {
  const { user } = useCurrentUser();
  const { mutateAsync: createEvent, isPending: isSending } = useNostrPublish();
  const { mutateAsync: uploadFile, isPending: isUploading } = useUploadFile();
  const { emojis: customEmojis } = useCustomEmojis();
  const { toast } = useToast();
  const isMobile = useIsMobile();

  // Scope @-mentions to people in the room: admins, members, and anyone who
  // has spoken in this view. DMs (relayUrl === "dm") have no room, so mentions
  // are disabled there.
  const isDM = relayUrl === "dm";
  const { data: groupDetails } = useGroup(isDM ? undefined : relayUrl, isDM ? undefined : groupId);
  const memberPubkeys = useMemo(() => {
    if (isDM) return undefined;
    const set = new Set<string>();
    for (const a of groupDetails?.admins ?? []) set.add(a.pubkey);
    for (const m of groupDetails?.members ?? []) set.add(m);
    for (const m of messages) set.add(m.pubkey);
    if (user) set.add(user.pubkey);
    return [...set];
  }, [isDM, groupDetails?.admins, groupDetails?.members, messages, user]);

  const draftKey = `chat-draft:${relayUrl}:${groupId}${draftScope ? `:${draftScope}` : ""}`;

  const [content, setContent] = useState(() => readDraft(draftKey).content);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Keeps the picker mounted through its slide-down exit animation.
  const [pickerMounted, setPickerMounted] = useState(false);
  // Animation target for the slide-up/down (toggled a frame after mount).
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerTab, setPickerTab] = useState<"emoji" | "gif" | "stickers">("emoji");
  const [plusOpen, setPlusOpen] = useState(false);
  const [removedEmbeds, setRemovedEmbeds] = useState<Set<string>>(new Set());
  /** Maps uploaded file URLs to their NIP-94 tags (grouped per upload). */
  const [uploadedFileGroups, setUploadedFileGroups] = useState<Map<string, string[][]>>(
    () => new Map(readDraft(draftKey).attachments),
  );

  // Poll mode state
  const [mode, setMode] = useState<"post" | "poll">("post");
  // Mount + animation-target flags so the poll panel slides up/down like the picker.
  const [pollMounted, setPollMounted] = useState(false);
  const [pollVisible, setPollVisible] = useState(false);
  const [pollOptions, setPollOptions] = useState([
    { id: pollOptionId(), label: "" },
    { id: pollOptionId(), label: "" },
  ]);
  const [pollType, setPollType] = useState<"singlechoice" | "multiplechoice">("singlechoice");
  const [pollDuration, setPollDuration] = useState<7 | 3 | 1 | 0>(7);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const pickerToggleRef = useRef<HTMLButtonElement>(null);
  const { insertAtCursor, insertEmoji } = useInsertText(textareaRef, content, setContent);

  // Let other components (e.g. the member list) request a mention insertion.
  useMentionInsertions((text) => {
    insertEmoji(text);
    textareaRef.current?.focus();
  });

  // Voice recording
  const voiceRecorder = useVoiceRecorder();
  const [isPublishingVoice, setIsPublishingVoice] = useState(false);

  // When switching channels, load that channel's draft (text + attachments).
  useEffect(() => {
    const draft = readDraft(draftKey);
    setContent(draft.content);
    setUploadedFileGroups(new Map(draft.attachments));
    setRemovedEmbeds(new Set());
    setMode("post");
  }, [draftKey]);

  // Auto-resize the textarea as content grows/shrinks.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [content]);

  // Focus the textarea when starting a reply.
  useEffect(() => {
    if (replyTo) textareaRef.current?.focus();
  }, [replyTo]);

  // Focus on mount when requested (e.g. the thread panel opening via /thread).
  useEffect(() => {
    if (autoFocus) requestAnimationFrame(() => textareaRef.current?.focus());
  }, [autoFocus]);

  // Dismiss the emoji/GIF/sticker picker when interacting outside it — e.g.
  // clicking back into the chat messages or the composer's text input.
  useEffect(() => {
    if (!pickerOpen) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (pickerRef.current?.contains(target)) return;
      if (pickerToggleRef.current?.contains(target)) return;
      setPickerOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [pickerOpen]);

  // Mount the picker on open; keep it in the DOM briefly on close so the
  // slide-down exit transition can play before unmounting.
  useEffect(() => {
    if (pickerOpen) {
      setPickerMounted(true);
      return;
    }
    setPickerVisible(false);
    if (!pickerMounted) return;
    const t = setTimeout(() => setPickerMounted(false), 200);
    return () => clearTimeout(t);
  }, [pickerOpen, pickerMounted]);

  // Once mounted (and still open), flip the animation target on the next paint
  // so the enter transition runs from the collapsed (0fr) state to open (1fr).
  useEffect(() => {
    if (!pickerMounted || !pickerOpen) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setPickerVisible(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [pickerMounted, pickerOpen]);

  // Same mount/slide lifecycle as the picker, for the inline poll options panel.
  const pollMode = mode === "poll";
  useEffect(() => {
    if (pollMode) {
      setPollMounted(true);
      return;
    }
    setPollVisible(false);
    if (!pollMounted) return;
    const t = setTimeout(() => setPollMounted(false), 200);
    return () => clearTimeout(t);
  }, [pollMode, pollMounted]);

  useEffect(() => {
    if (!pollMounted || !pollMode) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setPollVisible(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [pollMounted, pollMode]);

  // Auto-save draft (debounced): persists the text and any uploaded attachments
  // (already-uploaded Blossom URLs, so safe to serialize) per channel.
  useEffect(() => {
    const timer = setTimeout(() => {
      writeDraft(draftKey, content, uploadedFileGroups);
    }, 300);
    return () => clearTimeout(timer);
  }, [content, uploadedFileGroups, draftKey]);

  // Detect quote embeds in content (nevent, note, naddr) for preview + q tags.
  const detectedEmbeds = useMemo(() => {
    const embeds: DetectedEmbed[] = [];
    const matches = content.matchAll(
      /(?:nostr:)?\b(nevent1|note1|naddr1)([023456789acdefghjklmnpqrstuvwxyz]+)\b/g,
    );
    for (const match of matches) {
      const bech32 = `${match[1]}${match[2]}`;
      try {
        const decoded = nip19.decode(bech32);
        if (decoded.type === "nevent") {
          embeds.push({
            type: "nevent",
            value: match[0],
            index: match.index!,
            eventId: decoded.data.id,
            relay: decoded.data.relays?.[0],
            author: decoded.data.author,
          });
        } else if (decoded.type === "note") {
          embeds.push({ type: "note", value: match[0], index: match.index!, eventId: decoded.data });
        } else if (decoded.type === "naddr") {
          embeds.push({
            type: "naddr",
            value: match[0],
            index: match.index!,
            addr: {
              kind: decoded.data.kind,
              pubkey: decoded.data.pubkey,
              identifier: decoded.data.identifier,
            },
          });
        }
      } catch {
        // Invalid bech32, skip
      }
    }
    return embeds.sort((a, b) => a.index - b.index);
  }, [content]);

  const visibleEmbeds = useMemo(
    () => detectedEmbeds.filter((embed) => !removedEmbeds.has(embed.value)),
    [detectedEmbeds, removedEmbeds],
  );

  /** Uploaded attachments (insertion-ordered) derived from their NIP-94 tags. */
  const attachments = useMemo(
    () =>
      Array.from(uploadedFileGroups.entries()).map(([url, tags]) => {
        const mime = tags.find((t) => t[0] === "m")?.[1] ?? "";
        return { url, mime, isImage: mime.startsWith("image/") };
      }),
    [uploadedFileGroups],
  );

  const removeAttachment = useCallback((url: string) => {
    setUploadedFileGroups((prev) => {
      const next = new Map(prev);
      next.delete(url);
      return next;
    });
    // Also drop the URL from the text if it was typed/pasted there.
    setContent((prev) =>
      prev
        .split("\n")
        .filter((line) => line.trim() !== url)
        .join("\n"),
    );
  }, []);

  /** Register an externally-sourced media URL (GIF, sticker) as an attachment
   *  chip, so it previews above the input instead of pasting a raw URL. */
  const registerAttachment = useCallback((url: string, fallbackMime: string, dim?: string) => {
    const ext = url.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
    const extMime = mimeFromExt(ext);
    const mime = extMime === "application/octet-stream" ? fallbackMime : extMime;
    const tags: string[][] = [["url", url], ["m", mime]];
    if (dim) tags.push(["dim", dim]);
    setUploadedFileGroups((prev) => new Map(prev).set(url, tags));
  }, []);

  const resetComposeState = useCallback(() => {
    setContent("");
    setPickerOpen(false);
    setRemovedEmbeds(new Set());
    setUploadedFileGroups(new Map());
    setMode("post");
    setPollOptions([{ id: pollOptionId(), label: "" }, { id: pollOptionId(), label: "" }]);
    setPollType("singlechoice");
    setPollDuration(7);
    try {
      localStorage.removeItem(draftKey);
    } catch {
      // ignore
    }
    onCancelReply?.();
    // Keep the composer focused after sending so the user can immediately type
    // the next message (clicking the send button otherwise drops focus).
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [draftKey, onCancelReply]);

  const handleFileUpload = useCallback(async (file: File) => {
    try {
      const isImage = file.type.startsWith("image/");

      let uploadableFile = file;
      let resizedDim: string | undefined;

      if (isImage) {
        // Resize & optimize images before uploading.
        const resized = await resizeImage(file);
        uploadableFile = resized.file;
        resizedDim = resized.dimensions;
      }

      const tags = await uploadFile(uploadableFile);
      const url = tags[0][1];

      // Compute dim + blurhash and inject into the NIP-94 tags.
      if (isImage) {
        const hasTag = (name: string) => tags.some((t) => t[0] === name);
        if (resizedDim && !hasTag("dim")) tags.push(["dim", resizedDim]);
        if (!hasTag("blurhash")) {
          const { blurhash } = await getImageMeta(uploadableFile);
          if (blurhash) tags.push(["blurhash", blurhash]);
        }
      }

      setUploadedFileGroups((prev) => new Map(prev).set(url, tags));
      // The URL is tracked as an attachment chip (rendered above the input)
      // rather than dumped into the text; it's appended to content on send.
    } catch {
      toast({ title: "Upload failed", description: "Could not upload file.", variant: "destructive" });
    }
  }, [uploadFile, toast]);

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    // Upload every pasted file (images, video, audio). Non-file items (plain
    // text, HTML) fall through to the textarea's default paste handling.
    const files = Array.from(items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null && ACCEPTED_PASTE_RE.test(f.type));

    if (files.length === 0) return;
    e.preventDefault();
    for (const file of files) {
      await handleFileUpload(file);
    }
  }, [handleFileUpload]);

  // Drag-and-drop upload onto the composer. `dragDepth` tracks nested
  // enter/leave events so the overlay doesn't flicker over child elements.
  const [isDragging, setIsDragging] = useState(false);
  const dragDepth = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files ?? []).filter((f) => ACCEPTED_PASTE_RE.test(f.type));
    dragDepth.current = 0;
    setIsDragging(false);
    if (files.length === 0) return;
    e.preventDefault();
    for (const file of files) {
      await handleFileUpload(file);
    }
  }, [handleFileUpload]);

  /** Build the common NIP-29 + content-derived tags for an outgoing message. */
  const buildMessageTags = useCallback((finalContent: string): string[][] => {
    // NOTE: we deliberately do NOT emit NIP-29 `previous` timeline tags.
    // relay29's CheckPreviousTag rejects any event whose first `previous` ref
    // isn't in the group's in-memory last-50 ring. We can only pick refs from a
    // local (and own-excluded) message snapshot, which routinely drifts out of
    // that window — especially when replying to older messages — causing the
    // relay to silently drop legitimate messages/replies. `previous` is
    // optional in NIP-29 and only guards against relay-fork attacks, which
    // don't apply to this single-host-per-group deployment.
    const tags: string[][] = [
      ["h", groupId],
    ];

    // Hashtags → t tags
    for (const t of new Set(extractHashtags(finalContent))) {
      tags.push(["t", t]);
    }

    // NIP-27 mention p tags — extract nostr:npub1/nprofile1 from content
    const mentionMatches = finalContent.matchAll(
      /nostr:(npub1|nprofile1)([023456789acdefghjklmnpqrstuvwxyz]+)/g,
    );
    const mentionedPubkeys = new Set<string>();
    for (const match of mentionMatches) {
      try {
        const decoded = nip19.decode(`${match[1]}${match[2]}`);
        if (decoded.type === "npub") {
          mentionedPubkeys.add(decoded.data);
        } else if (decoded.type === "nprofile") {
          mentionedPubkeys.add(decoded.data.pubkey);
        }
      } catch {
        // Invalid bech32, skip
      }
    }
    if (user) mentionedPubkeys.delete(user.pubkey);
    for (const pk of mentionedPubkeys) {
      tags.push(["p", pk]);
    }

    // Reply tags (NIP-10 marked)
    if (replyTo) {
      const rootTag = replyTo.tags.find(([name, , , marker]) => name === "e" && marker === "root");
      if (rootTag) {
        tags.push(["e", rootTag[1], rootTag[2] || relayUrl, "root", ...(rootTag[4] ? [rootTag[4]] : [])]);
        tags.push(["e", replyTo.id, relayUrl, "reply", replyTo.pubkey]);
      } else {
        tags.push(["e", replyTo.id, relayUrl, "root", replyTo.pubkey]);
      }
      if (replyTo.pubkey !== user?.pubkey && !mentionedPubkeys.has(replyTo.pubkey)) {
        tags.push(["p", replyTo.pubkey]);
      }
    }

    // NIP-18 quote tags for visible nevent/naddr embeds
    for (const embed of visibleEmbeds) {
      if (embed.type === "naddr" && embed.addr) {
        tags.push(["q", `${embed.addr.kind}:${embed.addr.pubkey}:${embed.addr.identifier}`]);
      } else if (embed.eventId) {
        tags.push(["q", embed.eventId, embed.relay ?? "", ...(embed.author ? [embed.author] : [])]);
      }
    }

    // NIP-30 emoji tags for custom emojis referenced in content
    if (customEmojis.length > 0) {
      const emojiMap = new Map(customEmojis.map((e) => [e.shortcode, e.url]));
      const shortcodeRegex = /:([a-zA-Z0-9_-]+):/g;
      const usedEmojis = new Set<string>();
      let emojiMatch;
      while ((emojiMatch = shortcodeRegex.exec(finalContent)) !== null) {
        const shortcode = emojiMatch[1];
        if (emojiMap.has(shortcode) && !usedEmojis.has(shortcode)) {
          usedEmojis.add(shortcode);
          tags.push(["emoji", shortcode, emojiMap.get(shortcode)!]);
        }
      }
    }

    // NIP-92 imeta tags for media URLs in content
    const mediaUrlMatches = finalContent.matchAll(new RegExp(IMETA_MEDIA_URL_REGEX.source, "gi"));
    const processedUrls = new Set<string>();
    for (const match of mediaUrlMatches) {
      const url = match[0];
      if (processedUrls.has(url)) continue;
      processedUrls.add(url);

      const fileTags = uploadedFileGroups.get(url);
      if (fileTags) {
        tags.push(["imeta", ...fileTags.map((tag) => `${tag[0]} ${tag[1]}`)]);
      } else {
        tags.push(["imeta", `url ${url}`, `m ${mimeFromExt(match[1].toLowerCase())}`]);
      }
    }

    return tags;
  }, [groupId, user, replyTo, relayUrl, visibleEmbeds, customEmojis, uploadedFileGroups]);

  /** Publish a finalized message body via the active send path. */
  const publishMessage = useCallback(async (finalText: string) => {
    if (!finalText || !user || isSending || finalText.length > MAX_CHARS) return;

    try {
      if (sendOverride) {
        // Delegated send (e.g. DMs): the caller owns publishing. Clear the
        // composer immediately and fire the send in the background so the user
        // can queue several messages in a row without the UI locking up. The
        // override (DM hook) serializes signing internally and surfaces
        // per-message delivery state, so we neither await nor reset on its
        // result here.
        resetComposeState();
        onSent?.();
        void Promise.resolve(sendOverride(finalText)).catch(() => {
          // Delivery/sign failures are surfaced inline by the override.
        });
      } else if (onOptimisticInsert) {
        // Optimistic group send: render the message immediately on sign, reset
        // the composer, then confirm/fail in the background.
        let signedId: string | undefined;
        resetComposeState();
        onSent?.();
        try {
          await createEvent({
            kind: KIND_GROUP_CHAT,
            content: finalText,
            tags: buildMessageTags(finalText),
            relay: relayUrl,
            onSigned: (event) => {
              signedId = event.id;
              onOptimisticInsert(event);
            },
          });
          if (signedId) onOptimisticSent?.(signedId);
        } catch (err) {
          // Surface the relay's rejection reason (NRelay1 throws OK:false
          // reasons as the Error message) instead of failing silently — a
          // message that "sends" then vanishes with no explanation is the
          // worst failure mode.
          if (signedId) onOptimisticFailed?.(signedId);
          toast({
            title: "Message not sent",
            description: relayRejectionMessage(err),
            variant: "destructive",
          });
        }
      } else {
        await createEvent({
          kind: KIND_GROUP_CHAT,
          content: finalText,
          tags: buildMessageTags(finalText),
          relay: relayUrl,
        });
        resetComposeState();
        onSent?.();
      }
    } catch (err) {
      toast({
        title: "Message not sent",
        description: relayRejectionMessage(err),
        variant: "destructive",
      });
    }
  }, [user, isSending, sendOverride, createEvent, buildMessageTags, relayUrl, resetComposeState, onSent, toast, onOptimisticInsert, onOptimisticSent, onOptimisticFailed]);

  /** Execute a parsed slash command's result (run action / send rewritten text). */
  const executeSlashCommand = useCallback(async (command: SlashCommand, arg: string) => {
    const result = command.run(arg, { canModerate, resolvePubkey: resolveNpubArg });
    if (result.type === "error") {
      toast({ title: "Command failed", description: result.message, variant: "destructive" });
      return;
    }
    if (result.type === "noop") {
      resetComposeState();
      return;
    }
    if (result.type === "action") {
      if (result.action.kind === "openPoll") {
        setContent("");
        setMode("poll");
        textareaRef.current?.focus();
      } else if (result.action.kind === "openMention") {
        // Seed an "@" so the mention autocomplete opens for the next keystroke.
        // A `prefix` (e.g. "/slap ") keeps a wrapping command so the resolved
        // mention re-runs that command on send.
        const prefix = result.action.prefix ?? "";
        const seed = `${prefix}@`;
        setContent(seed);
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          el?.focus();
          el?.setSelectionRange(seed.length, seed.length);
        });
      } else if (result.action.kind === "clearDraft") {
        resetComposeState();
      } else {
        // Delegated actions (moderation, open thread) handled by the parent.
        try {
          await onSlashAction?.(result.action);
          resetComposeState();
        } catch {
          toast({ title: "Command failed", description: "The action could not be completed.", variant: "destructive" });
        }
      }
      return;
    }
    // result.type === "send": publish the rewritten text.
    await publishMessage(result.text);
  }, [canModerate, onSlashAction, resetComposeState, toast, publishMessage]);

  /** Run a command picked from the autocomplete menu (Tab/Enter/click). */
  const runSlashFromMenu = useCallback((command: SlashCommand) => {
    const parsed = parseSlashCommand(textareaRef.current?.value ?? "");
    void executeSlashCommand(command, parsed?.command === command ? parsed.arg : "");
  }, [executeSlashCommand]);

  const handleSend = useCallback(async () => {
    const text = content.trim();

    // Slash commands: only when the message is purely a "/command …" with no
    // attachments, in group mode (not delegated DM/thread sends). Text commands
    // (/me, /shrug) rewrite the outgoing message; action/moderation commands
    // run a side-effect and send nothing.
    if (!sendOverride && text.startsWith("/") && attachments.length === 0) {
      const parsed = parseSlashCommand(text);
      if (parsed) {
        await executeSlashCommand(parsed.command, parsed.arg);
        return;
      }
      // Unknown /command: fall through and send it literally.
    }

    // Append any attachment URLs not already present in the text so the
    // imeta/media tagging in buildMessageTags picks them up.
    const extraUrls = attachments
      .map((a) => a.url)
      .filter((url) => !text.includes(url));
    const finalText = [text, ...extraUrls].filter(Boolean).join("\n");
    await publishMessage(finalText);
  }, [content, attachments, sendOverride, executeSlashCommand, publishMessage]);

  const pollFilledCount = pollOptions.filter((o) => o.label.trim()).length;
  const isPollValid = content.trim().length > 0 && pollFilledCount >= 2;
  // A message is sendable when there's text or at least one attachment.
  const hasContent = content.trim().length > 0 || attachments.length > 0;

  const handlePollSubmit = useCallback(async () => {
    const finalContent = content.trim();
    const filledOptions = pollOptions.filter((o) => o.label.trim());
    if (!finalContent || filledOptions.length < 2 || !user || isSending) return;

    const tags = buildMessageTags(finalContent);
    for (const opt of filledOptions) {
      tags.push(["option", opt.id, opt.label.trim()]);
    }
    tags.push(["polltype", pollType]);
    // NIP-88: votes must be sent to the relays listed in `relay` tags —
    // route them to the group's host relay so membership is enforced.
    tags.push(["relay", relayUrl]);
    if (pollDuration > 0) {
      tags.push(["endsAt", String(Math.floor(Date.now() / 1000) + pollDuration * 86_400)]);
    }
    tags.push(["alt", `Poll: ${finalContent}`]);

    try {
      await createEvent({ kind: KIND_POLL, content: finalContent, tags, relay: relayUrl });
      resetComposeState();
      onSent?.();
      toast({ title: "Poll published!" });
    } catch {
      toast({ title: "Error", description: "Failed to publish poll.", variant: "destructive" });
    }
  }, [content, pollOptions, user, isSending, buildMessageTags, pollType, pollDuration, createEvent, relayUrl, resetComposeState, onSent, toast]);

  /** Stop recording, upload, and send as a voice message (kind 9 + imeta). */
  const handleStopAndSendVoice = useCallback(async () => {
    if (!user) return;
    setIsPublishingVoice(true);
    try {
      const recording = await voiceRecorder.stopRecording();
      if (!recording) return;

      const extMap: Record<string, string> = {
        "audio/mp4": ".m4a",
        "audio/mp4;codecs=aac": ".m4a",
        "audio/aac": ".aac",
        "audio/webm;codecs=opus": ".webm",
        "audio/webm": ".webm",
        "audio/ogg;codecs=opus": ".ogg",
      };
      const ext = extMap[recording.mimeType] ?? ".webm";
      const file = new File([recording.blob], `voice-message-${Date.now()}${ext}`, {
        type: recording.mimeType,
      });

      const uploadTags = await uploadFile(file);
      const audioUrl = uploadTags[0][1];

      const tags = buildMessageTags(audioUrl);
      // Replace the basic imeta tag with one carrying waveform + duration.
      const imetaIndex = tags.findIndex((t) => t[0] === "imeta" && t.includes(`url ${audioUrl}`));
      const imetaTag = [
        "imeta",
        `url ${audioUrl}`,
        `m ${recording.mimeType}`,
        `waveform ${recording.waveform.join(" ")}`,
        `duration ${Math.round(recording.duration)}`,
      ];
      if (imetaIndex >= 0) {
        tags[imetaIndex] = imetaTag;
      } else {
        tags.push(imetaTag);
      }

      await createEvent({
        kind: KIND_GROUP_CHAT,
        content: audioUrl,
        tags,
        relay: relayUrl,
      });

      onCancelReply?.();
      onSent?.();
    } catch {
      toast({ title: "Error", description: "Failed to send voice message.", variant: "destructive" });
    } finally {
      setIsPublishingVoice(false);
    }
  }, [user, voiceRecorder, uploadFile, buildMessageTags, createEvent, relayUrl, onCancelReply, onSent, toast]);

  const handleStartRecording = useCallback(async () => {
    try {
      await voiceRecorder.startRecording();
    } catch {
      toast({
        title: "Microphone access denied",
        description: "Please allow microphone access to record voice messages.",
        variant: "destructive",
      });
    }
  }, [voiceRecorder, toast]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (mode === "poll") {
        handlePollSubmit();
      } else {
        handleSend();
      }
    }
  };

  const charCount = content.length;

  return (
    <div
      className="relative shrink-0 pb-[env(safe-area-inset-bottom,0px)] sidebar:pb-1"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag-and-drop upload overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-30 m-1 flex items-center justify-center clip-corner-lg border-2 border-dashed border-primary/60 bg-primary/10 backdrop-blur-sm pointer-events-none animate-in fade-in-0 duration-150">
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            <Paperclip className="size-4" />
            Drop files to upload
          </div>
        </div>
      )}

      {/* Reply banner */}
      {replyTo && <ReplyBanner event={replyTo} onCancel={onCancelReply} />}

      {/* Detected quote embeds */}
      {visibleEmbeds.length > 0 && (
        <div className="px-3 pt-2 space-y-1 max-h-44 overflow-y-auto animate-in slide-in-from-top-2 fade-in-0 duration-200">
          {visibleEmbeds.map((embed) => (
            <div key={embed.value} className="relative">
              {embed.type === "naddr" && embed.addr ? (
                <EmbeddedNaddr addr={embed.addr} className="my-0" />
              ) : (
                <EmbeddedNote
                  eventId={embed.eventId!}
                  relays={embed.relay ? [embed.relay] : undefined}
                  authorHint={embed.author}
                  className="my-0"
                />
              )}
              <button
                type="button"
                aria-label="Remove embed"
                className="absolute top-1.5 right-1.5 p-1 rounded-full bg-background/80 text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setRemovedEmbeds((prev) => new Set(prev).add(embed.value))}
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Attachment previews — uploaded images render as inline thumbnails. */}
      {(attachments.length > 0 || isUploading) && (
        <div className="flex flex-wrap gap-2 px-3 pt-2 animate-in slide-in-from-top-2 fade-in-0 duration-200">
          {attachments.map((att) => (
            <div
              key={att.url}
              className="group relative size-20 rounded-lg overflow-hidden border border-border bg-secondary/40 shrink-0"
            >
              {att.isImage ? (
                <img src={att.url} alt="attachment" className="size-full object-cover" />
              ) : (
                <div className="size-full flex flex-col items-center justify-center gap-1 text-muted-foreground p-1">
                  <Paperclip className="size-5" />
                  <span className="text-[10px] truncate max-w-full">
                    {att.mime.split("/")[1] || "file"}
                  </span>
                </div>
              )}
              <button
                type="button"
                aria-label="Remove attachment"
                onClick={() => removeAttachment(att.url)}
                className="absolute top-1 right-1 p-0.5 rounded-full bg-background/80 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
          {isUploading && (
            <div className="size-20 rounded-lg border border-border bg-secondary/40 shrink-0 flex items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
      )}

      <div className="p-2">
        {voiceRecorder.isRecording || isPublishingVoice ? (
          /* ── Voice recording UI ─────────────────────────────── */
          <div className="flex items-center gap-3 rounded-xl bg-destructive/5 border border-destructive/20 px-3 py-2.5">
            <div className="flex items-center gap-2 min-w-0">
              <div className="size-2.5 rounded-full bg-destructive animate-pulse shrink-0" />
              <span className="text-sm font-medium tabular-nums text-destructive">
                {formatTime(voiceRecorder.recordingDuration)}
              </span>
            </div>

            {/* Live waveform preview */}
            <div className="flex-1 flex items-center gap-[2px] h-6 overflow-hidden">
              {voiceRecorder.liveWaveform.slice(-60).map((amp, i) => {
                const h = 3 + (amp / 100) * 21;
                return (
                  <div
                    key={i}
                    className="w-[3px] shrink-0 rounded-full bg-destructive/60"
                    style={{ height: `${h}px` }}
                  />
                );
              })}
            </div>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={voiceRecorder.cancelRecording}
                  disabled={isPublishingVoice}
                  className="p-2 rounded-full text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-40"
                >
                  <X className="size-[18px]" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Cancel</TooltipContent>
            </Tooltip>

            <Button
              onClick={handleStopAndSendVoice}
              disabled={isPublishingVoice || voiceRecorder.recordingDuration < 0.5}
              className="rounded-full px-4 font-bold"
              size="sm"
            >
              {isPublishingVoice
                ? <Loader2 className="size-4 animate-spin mr-1.5" />
                : <Square className="size-3.5 mr-1.5" fill="currentColor" />}
              {isPublishingVoice ? "Sending..." : "Send"}
            </Button>
          </div>
        ) : (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*,audio/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = e.target.files;
                if (files) {
                  Array.from(files).forEach((file) => handleFileUpload(file));
                }
                e.target.value = "";
              }}
            />

            {/* ── Input pill: + | textarea | emoji | mic/send ──── */}
            <div className="flex items-end gap-0.5 clip-corner-lg bg-secondary/60 px-1.5 py-1.5">
              {/* Plus menu: attach + poll (Discord-style) */}
              <Popover open={plusOpen} onOpenChange={setPlusOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="More options"
                    disabled={isUploading}
                    className={cn(
                      "p-2 shrink-0 rounded-full transition-colors disabled:opacity-40 flex items-center justify-center size-9",
                      plusOpen || mode === "poll"
                        ? "text-primary bg-primary/10"
                        : "text-muted-foreground hover:text-foreground hover:bg-secondary",
                    )}
                  >
                    {isUploading
                      ? <Loader2 className="size-5 animate-spin" />
                      : <Plus className={cn("size-5 transition-transform", plusOpen && "rotate-45")} />}
                  </button>
                </PopoverTrigger>
                <PopoverContent side="top" align="start" sideOffset={8} className="w-44 p-1.5 rounded-xl border-border shadow-lg">
                  <div className="flex flex-col gap-0.5">
                    <button
                      type="button"
                      onClick={() => {
                        fileInputRef.current?.click();
                        setPlusOpen(false);
                      }}
                      className="flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
                    >
                      <Paperclip className="size-4" />
                      <span className="font-medium">Attach file</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMode((m) => (m === "poll" ? "post" : "poll"));
                        setPlusOpen(false);
                        textareaRef.current?.focus();
                      }}
                      hidden={Boolean(sendOverride)}
                      className={cn(
                        "flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-sm transition-colors",
                        sendOverride && "hidden",
                        mode === "poll"
                          ? "text-primary bg-primary/10"
                          : "text-muted-foreground hover:text-foreground hover:bg-secondary/60",
                      )}
                    >
                      <BarChart3 className="size-4" />
                      <span className="font-medium">{mode === "poll" ? "Remove poll" : "Poll"}</span>
                    </button>
                  </div>
                </PopoverContent>
              </Popover>

              {/* Borderless, self-growing textarea */}
              <div className="relative flex-1 min-w-0">
                <textarea
                  ref={textareaRef}
                  dir="auto"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  placeholder={mode === "poll" ? "Ask a question…" : (placeholder ?? "Message the channel…")}
                  rows={1}
                  maxLength={MAX_CHARS}
                  className="block w-full resize-none bg-transparent border-0 outline-none px-1.5 py-2 leading-5 text-base md:text-sm placeholder:text-muted-foreground disabled:opacity-50 max-h-40 overflow-y-auto align-middle"
                />
                {!isDM && (
                  <MentionAutocomplete
                    textareaRef={textareaRef}
                    content={content}
                    onInsertMention={insertAtCursor}
                    restrictToPubkeys={memberPubkeys}
                  />
                )}
                {!sendOverride && (
                  <SlashCommandAutocomplete
                    textareaRef={textareaRef}
                    content={content}
                    canModerate={canModerate}
                    onInsertCommand={insertAtCursor}
                    onRunCommand={runSlashFromMenu}
                  />
                )}
                <EmojiShortcodeAutocomplete
                  textareaRef={textareaRef}
                  content={content}
                  onInsertEmoji={insertAtCursor}
                />
              </div>

              {/* Emoji / GIF / sticker picker toggle */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    ref={pickerToggleRef}
                    onClick={() => setPickerOpen((v) => !v)}
                    aria-label="Emoji / GIF / Stickers"
                    className={cn(
                      "p-2 shrink-0 rounded-full transition-colors flex items-center justify-center size-9",
                      pickerOpen
                        ? "text-primary bg-primary/10"
                        : "text-muted-foreground hover:text-foreground hover:bg-secondary",
                    )}
                  >
                    <Smile className="size-5" />
                  </button>
                </TooltipTrigger>
                {!pickerOpen && <TooltipContent>Emoji / GIF</TooltipContent>}
              </Tooltip>

              {/* Mic when empty, send when there's something to send (Signal-style) */}
              {mode === "post" && !hasContent && !sendOverride && voiceRecorder.isSupported ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleStartRecording}
                      aria-label="Voice message"
                      className="p-2 shrink-0 rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors flex items-center justify-center size-9"
                    >
                      <Mic className="size-5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Voice message</TooltipContent>
                </Tooltip>
              ) : (
                <button
                  type="button"
                  onClick={mode === "poll" ? handlePollSubmit : handleSend}
                  disabled={mode === "poll" ? !isPollValid || isSending : !hasContent || isSending}
                  aria-label={mode === "poll" ? "Publish poll" : "Send message"}
                  className="p-2 shrink-0 clip-corner-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40 disabled:bg-transparent disabled:text-muted-foreground flex items-center justify-center size-9"
                >
                  {isSending
                    ? <Loader2 className="size-4 animate-spin" />
                    : <ArrowUpRight className="size-5" strokeWidth={2.5} />}
                </button>
              )}
            </div>

            {/* Char counter — only when approaching the limit */}
            {charCount > MAX_CHARS * 0.8 && (
              <div className="flex justify-end pt-1 pr-2">
                <span
                  className={cn(
                    "text-xs tabular-nums",
                    charCount >= MAX_CHARS ? "text-destructive font-semibold" : "text-muted-foreground",
                  )}
                >
                  {MAX_CHARS - charCount}
                </span>
              </div>
            )}

            {/* ── Poll options ─────────────────────────────────── */}
            {pollMounted && (
              <div
                className={cn(
                  "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
                  pollVisible ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
                )}
              >
                <div className="overflow-hidden min-h-0">
                <div className="space-y-2 pt-2">
                  <div className="space-y-1.5">
                    {pollOptions.map((opt, idx) => (
                      <div key={opt.id} className="flex items-center gap-2">
                      <input
                        type="text"
                        value={opt.label}
                        onChange={(e) =>
                          setPollOptions((prev) =>
                            prev.map((o) => (o.id === opt.id ? { ...o, label: e.target.value } : o)),
                          )}
                        placeholder={`Option ${idx + 1}`}
                        maxLength={100}
                        className="flex-1 bg-secondary/40 rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary/40 placeholder:text-muted-foreground"
                      />
                      <button
                        type="button"
                        aria-label="Remove option"
                        onClick={() => {
                          if (pollOptions.length > 2) {
                            setPollOptions((prev) => prev.filter((o) => o.id !== opt.id));
                          }
                        }}
                        disabled={pollOptions.length <= 2}
                        className="p-1 rounded-full text-muted-foreground hover:text-destructive transition-colors disabled:opacity-20"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  ))}

                  {pollOptions.length < 8 && (
                    <button
                      type="button"
                      onClick={() => setPollOptions((prev) => [...prev, { id: pollOptionId(), label: "" }])}
                      className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors pt-0.5"
                    >
                      <Plus className="size-3" />
                      Add option
                    </button>
                  )}
                </div>

                {/* Poll settings — pill toggles */}
                <div className="flex flex-wrap gap-2">
                  {(["singlechoice", "multiplechoice"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setPollType(t)}
                      className={cn(
                        "text-xs px-2.5 py-1 rounded-full border transition-colors",
                        pollType === t
                          ? "border-primary bg-primary/10 text-primary font-medium"
                          : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30",
                      )}
                    >
                      {t === "singlechoice" ? "Single choice" : "Multiple choice"}
                    </button>
                  ))}
                  <div className="w-px bg-border self-stretch mx-0.5" />
                  {([1, 3, 7, 0] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setPollDuration(d)}
                      className={cn(
                        "text-xs px-2.5 py-1 rounded-full border transition-colors",
                        pollDuration === d
                          ? "border-primary bg-primary/10 text-primary font-medium"
                          : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30",
                      )}
                    >
                      {d === 0 ? "∞" : `${d}d`}
                    </button>
                  ))}
                </div>
              </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Emoji / GIF / sticker picker panel ───────────────── */}
      {pickerMounted && !voiceRecorder.isRecording && (
        <div
          ref={pickerRef}
          className={cn(
            "shrink-0 grid transition-[grid-template-rows,opacity] duration-200 ease-out",
            pickerVisible
              ? "grid-rows-[1fr] opacity-100"
              : "grid-rows-[0fr] opacity-0",
          )}
        >
          <div className="overflow-hidden min-h-0">
          <div className="flex gap-1 px-3 pt-2">
            <button
              type="button"
              onClick={() => setPickerTab("emoji")}
              className={cn(
                "flex items-center justify-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-medium transition-colors",
                pickerTab === "emoji"
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
            >
              <Smile className="size-3.5" />
              Emoji
            </button>
            <button
              type="button"
              onClick={() => setPickerTab("gif")}
              className={cn(
                "flex items-center justify-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-medium transition-colors",
                pickerTab === "gif"
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
            >
              <svg width="14" height="14" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <rect x="1" y="1" width="16" height="16" rx="3" stroke="currentColor" strokeWidth="1.5" fill="none" />
                <text x="9" y="9" textAnchor="middle" dominantBaseline="central" fontSize="7" fontWeight="700" fontFamily="system-ui,sans-serif" fill="currentColor" letterSpacing="0.5">GIF</text>
              </svg>
              GIF
            </button>
            {customEmojis.length > 0 && (
              <button
                type="button"
                onClick={() => setPickerTab("stickers")}
                className={cn(
                  "flex items-center justify-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-medium transition-colors",
                  pickerTab === "stickers"
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted",
                )}
              >
                <Sticker className="size-3.5" />
                Stickers
              </button>
            )}
          </div>

          {pickerTab === "emoji" ? (
            <Suspense
              fallback={
                <div className="w-full h-[360px] flex items-center justify-center">
                  <Loader2 className="size-6 animate-spin text-muted-foreground" />
                </div>
              }
            >
              <LazyEmojiPicker
                customEmojis={customEmojis}
                onSelect={(selection) => {
                  if (selection.type === "native") {
                    insertEmoji(selection.emoji);
                  } else {
                    insertEmoji(`:${selection.shortcode}:`);
                  }
                }}
              />
            </Suspense>
          ) : pickerTab === "stickers" ? (
            <StickerPicker
              customEmojis={customEmojis}
              height={360}
              autoFocus={!isMobile}
              onSelect={(emoji) => {
                registerAttachment(emoji.url, "image/webp");
                setPickerOpen(false);
              }}
            />
          ) : (
            <GifPicker
              onSelect={(gif) => {
                registerAttachment(gif.url, "image/gif", `${gif.width}x${gif.height}`);
                setPickerOpen(false);
              }}
            />
          )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Compact banner above the composer showing the message being replied to. */
function ReplyBanner({ event, onCancel }: { event: NostrEvent; onCancel?: () => void }) {
  const author = useAuthor(event.pubkey);
  const displayName = useScopedDisplayName(event.pubkey, author.data?.metadata);

  // Strip media URLs for a compact text preview.
  const preview = event.content.replace(new RegExp(IMETA_MEDIA_URL_TEST_REGEX.source, "gi"), "📎").trim();

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-secondary/40 border-b text-xs animate-in slide-in-from-top-2 fade-in-0 duration-200">
      <Reply className="size-3.5 text-muted-foreground shrink-0" />
      <span className="text-muted-foreground shrink-0">
        Replying to <span className="font-semibold text-foreground">{displayName}</span>
      </span>
      <span className="text-muted-foreground/70 truncate flex-1">{preview}</span>
      <button
        type="button"
        aria-label="Cancel reply"
        onClick={onCancel}
        className="p-1 rounded-full text-muted-foreground hover:text-foreground transition-colors shrink-0"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
