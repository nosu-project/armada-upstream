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
import { StickerPicker } from "@/components/chat/StickerPicker";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCustomEmojis } from "@/hooks/useCustomEmojis";
import { useInsertText } from "@/hooks/useInsertText";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { useToast } from "@/hooks/useToast";
import { useUploadFile } from "@/hooks/useUploadFile";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { formatTime } from "@/lib/formatTime";
import { getDisplayName } from "@/lib/getDisplayName";
import { extractHashtags } from "@/lib/hashtag";
import { IMETA_MEDIA_URL_REGEX, IMETA_MEDIA_URL_TEST_REGEX, mimeFromExt } from "@/lib/mediaUrls";
import { buildPreviousRefs, KIND_GROUP_CHAT } from "@/lib/nip29";
import { resizeImage } from "@/lib/resizeImage";
import { cn } from "@/lib/utils";

import type { AddrCoords } from "@/hooks/useEvent";
import type { NostrEvent } from "@nostrify/nostrify";

/** Lazy-loaded EmojiPicker — keeps emoji-mart + its data out of the main bundle. */
const LazyEmojiPicker = lazy(() => import("@/components/chat/EmojiPicker").then((m) => ({ default: m.EmojiPicker })));

/** NIP-88 poll kind. */
const KIND_POLL = 1068;

const MAX_CHARS = 2000;

/** Short random ID for poll options. */
function pollOptionId(): string {
  return Math.random().toString(36).slice(2, 8);
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
}

/**
 * Rich chat composer for NIP-29 groups: multi-line textarea with @-mention
 * and :shortcode: autocomplete, emoji/GIF/sticker pickers, media uploads with
 * NIP-92 imeta tags, paste-to-upload, voice messages, NIP-88 polls, replies,
 * NIP-18 quotes, and per-channel drafts.
 */
export function ChatComposer({ relayUrl, groupId, messages, replyTo, onCancelReply, onSent }: ChatComposerProps) {
  const { user } = useCurrentUser();
  const { mutateAsync: createEvent, isPending: isSending } = useNostrPublish();
  const { mutateAsync: uploadFile, isPending: isUploading } = useUploadFile();
  const { emojis: customEmojis } = useCustomEmojis();
  const { toast } = useToast();
  const isMobile = useIsMobile();

  const draftKey = `chat-draft:${relayUrl}:${groupId}`;

  const [content, setContent] = useState(() => {
    try {
      return localStorage.getItem(draftKey) ?? "";
    } catch {
      return "";
    }
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTab, setPickerTab] = useState<"emoji" | "gif" | "stickers">("emoji");
  const [plusOpen, setPlusOpen] = useState(false);
  const [removedEmbeds, setRemovedEmbeds] = useState<Set<string>>(new Set());
  /** Maps uploaded file URLs to their NIP-94 tags (grouped per upload). */
  const [uploadedFileGroups, setUploadedFileGroups] = useState<Map<string, string[][]>>(new Map());

  // Poll mode state
  const [mode, setMode] = useState<"post" | "poll">("post");
  const [pollOptions, setPollOptions] = useState([
    { id: pollOptionId(), label: "" },
    { id: pollOptionId(), label: "" },
  ]);
  const [pollType, setPollType] = useState<"singlechoice" | "multiplechoice">("singlechoice");
  const [pollDuration, setPollDuration] = useState<7 | 3 | 1 | 0>(7);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { insertAtCursor, insertEmoji } = useInsertText(textareaRef, content, setContent);

  // Voice recording
  const voiceRecorder = useVoiceRecorder();
  const [isPublishingVoice, setIsPublishingVoice] = useState(false);

  // When switching channels, load that channel's draft.
  useEffect(() => {
    try {
      setContent(localStorage.getItem(draftKey) ?? "");
    } catch {
      setContent("");
    }
    setRemovedEmbeds(new Set());
    setUploadedFileGroups(new Map());
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

  // Auto-save draft (debounced).
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        if (content.trim()) {
          localStorage.setItem(draftKey, content);
        } else {
          localStorage.removeItem(draftKey);
        }
      } catch {
        // localStorage might be full or unavailable
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [content, draftKey]);

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
      setContent((prev) => (prev ? prev + "\n" + url : url));
    } catch {
      toast({ title: "Upload failed", description: "Could not upload file.", variant: "destructive" });
    }
  }, [uploadFile, toast]);

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          await handleFileUpload(file);
        }
        break;
      }
    }
  }, [handleFileUpload]);

  /** Build the common NIP-29 + content-derived tags for an outgoing message. */
  const buildMessageTags = useCallback((finalContent: string): string[][] => {
    const tags: string[][] = [
      ["h", groupId],
      ...buildPreviousRefs(messages, user?.pubkey ?? "").map((ref) => ["previous", ref]),
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
  }, [groupId, messages, user, replyTo, relayUrl, visibleEmbeds, customEmojis, uploadedFileGroups]);

  const handleSend = useCallback(async () => {
    const text = content.trim();
    if (!text || !user || isSending || text.length > MAX_CHARS) return;

    try {
      await createEvent({
        kind: KIND_GROUP_CHAT,
        content: text,
        tags: buildMessageTags(text),
        relay: relayUrl,
      });
      resetComposeState();
      onSent?.();
    } catch {
      toast({
        title: "Message not sent",
        description: "The relay rejected the message.",
        variant: "destructive",
      });
    }
  }, [content, user, isSending, createEvent, buildMessageTags, relayUrl, resetComposeState, onSent, toast]);

  const pollFilledCount = pollOptions.filter((o) => o.label.trim()).length;
  const isPollValid = content.trim().length > 0 && pollFilledCount >= 2;

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
    <div className="shrink-0 pb-safe">
      {/* Reply banner */}
      {replyTo && <ReplyBanner event={replyTo} onCancel={onCancelReply} />}

      {/* Detected quote embeds */}
      {visibleEmbeds.length > 0 && (
        <div className="px-3 pt-2 space-y-1 max-h-44 overflow-y-auto">
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

      <div className="p-3 pb-2">
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
            <div className="flex items-end gap-0.5 clip-corner-lg bg-secondary/60 px-1.5 py-1">
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
                      className={cn(
                        "flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-sm transition-colors",
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
                  placeholder={mode === "poll" ? "Ask a question…" : "Message the channel…"}
                  rows={1}
                  maxLength={MAX_CHARS}
                  className="block w-full resize-none bg-transparent border-0 outline-none px-1.5 py-2 leading-5 text-base md:text-sm placeholder:text-muted-foreground disabled:opacity-50 max-h-40 overflow-y-auto align-middle"
                  disabled={isSending}
                />
                <MentionAutocomplete
                  textareaRef={textareaRef}
                  content={content}
                  onInsertMention={insertAtCursor}
                />
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
              {mode === "post" && !content.trim() && voiceRecorder.isSupported ? (
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
                  disabled={mode === "poll" ? !isPollValid || isSending : !content.trim() || isSending}
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
            {mode === "poll" && (
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
            )}
          </>
        )}
      </div>

      {/* ── Emoji / GIF / sticker picker panel ───────────────── */}
      {pickerOpen && !voiceRecorder.isRecording && (
        <div className="shrink-0 overflow-hidden animate-in fade-in-0 duration-150 border-t">
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
                <div className="w-full h-[280px] flex items-center justify-center">
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
              height={280}
              autoFocus={!isMobile}
              onSelect={(emoji) => {
                setContent((prev) => (prev ? prev + "\n" + emoji.url : emoji.url));
                setPickerOpen(false);
              }}
            />
          ) : (
            <GifPicker
              onSelect={(gif) => {
                setContent((prev) => (prev ? prev + "\n" + gif.url : gif.url));
                setPickerOpen(false);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Compact banner above the composer showing the message being replied to. */
function ReplyBanner({ event, onCancel }: { event: NostrEvent; onCancel?: () => void }) {
  const author = useAuthor(event.pubkey);
  const displayName = getDisplayName(author.data?.metadata, event.pubkey);

  // Strip media URLs for a compact text preview.
  const preview = event.content.replace(new RegExp(IMETA_MEDIA_URL_TEST_REGEX.source, "gi"), "📎").trim();

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-secondary/40 border-b text-xs">
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
