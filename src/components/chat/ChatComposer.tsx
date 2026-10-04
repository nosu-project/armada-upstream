import {
  ArrowUpRight,
  BarChart3,
  Blocks,
  Camera,
  ImageIcon,
  Loader2,
  Mic,
  MonitorPlay,
  Paperclip,
  Plus,
  Quote,
  Reply,
  Smile,
  Square,
  SquareSlash,
  Sticker,
  X,
} from "lucide-react";
import { nip19 } from "nostr-tools";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AttachSheet, type AttachAction } from "@/components/chat/AttachSheet";
import { AttachmentTray, MAX_ALT_CHARS, type TrayItem } from "@/components/chat/AttachmentTray";
import { BotCommandComposer } from "@/components/chat/BotCommandComposer";
import { BrowseEmojiPacksButton } from "@/components/chat/BrowseEmojiPacksButton";
import { mayFocusOnSwitch, registerTypeToFocus } from "@/components/chat/typeToFocus";
import { authorsByRecency } from "@/components/chat/transport";
import type { PollDraft } from "@/components/chat/transport";
import { ReplyPreview } from "@/components/chat/ChatMessage";
import { EmojiShortcodeAutocomplete } from "@/components/chat/EmojiShortcodeAutocomplete";
import { GifPicker } from "@/components/chat/GifPicker";
import { Lightbox } from "@/components/chat/Lightbox";
import { MentionAutocomplete } from "@/components/chat/MentionAutocomplete";
import { SlashCommandAutocomplete } from "@/components/chat/SlashCommandAutocomplete";
import { StickerPicker } from "@/components/chat/StickerPicker";
import { WebxdcGamePicker } from "@/components/chat/WebxdcGamePicker";
import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useComposerBoundsRef } from "@/contexts/ComposerBoundsContext";
import { useAndroidBack } from "@/hooks/useAndroidBack";
import { useAppContext } from "@/hooks/useAppContext";
import { primeAudioMetadata, primeAudioWaveform } from "@/hooks/useAudioMetadata";
import { useAuthor } from "@/hooks/useAuthor";
import { useApps } from "@/hooks/useApps";
import { useChatScope } from "@/hooks/useChatScope";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useBotManifests } from "@/hooks/useBotManifests";
import { useCommandRequests } from "@/hooks/useCommandBus";
import { useCustomEmojis } from "@/hooks/useCustomEmojis";
import { useGroup } from "@/hooks/useGroup";
import { useGlobalImagePaste } from "@/hooks/useGlobalImagePaste";
import { useInsertText } from "@/hooks/useInsertText";
import { useMentionInsertions } from "@/hooks/useMentionBus";
import { useIsMobile, useIsTouch } from "@/hooks/useIsMobile";
import { useMountedTransition } from "@/hooks/useMountedTransition";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { useToast } from "@/hooks/useToast";
import { useUploadFile, useUploadPreflight } from "@/hooks/useUploadFile";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { getImageMeta } from "@/lib/imageProbe";
import { getAvatarShape } from "@/lib/avatarShape";
import type { AudioMetadata } from "@/lib/audioMetadata";
import { readAudioMetadata } from "@/lib/readAudioMetadata";
import { computeWaveform } from "@/lib/audioWaveform";
import { KvPrefixCache } from "@/lib/db/kvCache";
import { formatTime } from "@/lib/formatTime";
import { extractHashtags } from "@/lib/hashtag";
import { collectEmojiTags } from "@/lib/customEmoji";
import { completedShortcodeAt } from "@/lib/emojiShortcode";
import { encryptFileForUpload, encryptFileWithParams, MAX_DECRYPT_BYTES, primeAttachment } from "@/lib/encryptedMedia";
import { extForMime } from "@/lib/fileBytes";
import { galleryItemFile, hasMediaGallery, type GalleryItem } from "@/lib/mediaGallery";
import { extractWebxdcMeta } from "@/lib/webxdcMeta";
import { contentTagsFor, forwardedAttachment, stripUrlsFromText } from "@/lib/forwardMessage";
import { IMETA_MEDIA_URL_REGEX, mimeFromExt, modelFormat, modelMimeFromExt, type ModelFormat } from "@/lib/mediaUrls";
import { MAX_ENCRYPTED_BYTES, deviceInputLimit, keepUserFields, mimeOfPicked } from "@/lib/attachmentLimits";
import { describeRefusal, uploadFailureReason } from "@/lib/blossomPreflight";
import { KIND_GROUP_CHAT, relayRejectionMessage } from "@/lib/nip29";
import { resizeImage } from "@/lib/resizeImage";
import { parseChatRoute, roomPath } from "@/lib/routes";
import { consumeShareFor, onShareStashChanged } from "@/lib/shareTarget";
import { recordSent } from "@/lib/shareTargets";
import { sendsOnEnter } from "@/lib/sendOnEnter";
import { stripTrackingParamsInText } from "@/lib/trackingParams";
import { processVideo } from "@/lib/video/processVideo";
import { invocationTags, parseInvocation, usageLine, validateInvocation, type BotCommandEntry } from "@/lib/botCommands";
import { executeSlashCommand, parseSlashCommand, resolveNpubArg, type SlashAction, type SlashCapability, type SlashCommand } from "@/lib/slashCommands";
import { buildPollTags, KIND_POLL } from "@/lib/polls";
import { cn } from "@/lib/utils";
import { useAddrEvent, useEvent } from "@/hooks/useEvent";

import type { AddrCoords } from "@/hooks/useEvent";
import type { WebxdcApp } from "@/hooks/useWebxdcApps";
import type { ImetaEncryption } from "@/lib/imeta";
import type { ProcessedVideo } from "@/lib/video/types";
import type { NostrEvent } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import { WEBXDC_MIME, isWebxdcMime } from "@/lib/webxdcMime";
import { mintTopicId } from "@/lib/webxdcRealtime";

/** Lazy: keeps emoji-mart + its data out of the main bundle. */
const LazyEmojiPicker = lazy(() => import("@/components/chat/EmojiPicker").then((m) => ({ default: m.EmojiPicker })));

/** How many recently used bot commands the `/` menu keeps, per account. */
const BOT_RECENTS_CAP = 8;

/** Recently used bot commands, most recent first, as `<botHex>:<name>` keys. */
function readBotRecents(key: string): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

// The hard ceiling is Concord (CORD-01/02): NIP-44 plaintext is capped at
// 65,535 bytes PER LAYER, and the outer wrap holds the base64'd inner layer.
// 5,000 chars (≤3 UTF-8 bytes each) leaves ample headroom for tags.
const MAX_CHARS = 5000;

const MD_BREAKPOINT_PX = 768;

/** Empty-composer height per layout / font step / viewport height (see auto-resize). */
const emptyHeights = new Map<string, number>();

function replaceExtension(filename: string, ext: string): string {
  const dot = filename.lastIndexOf(".");
  return (dot > 0 ? filename.slice(0, dot) : filename) + ext;
}

/** Largest 3D model parsed for a preview still; bigger ones can take the tab down. */
const MAX_MODEL_PREVIEW_BYTES = 150 * 1024 * 1024;

/** A still of a 3D model, for its imeta `image`/`thumb`. Undefined on any failure, or after 30s. */
async function renderModelStill(file: File, format: ModelFormat): Promise<Blob | undefined> {
  if (file.size > MAX_MODEL_PREVIEW_BYTES) return undefined;
  try {
    const { renderModelPreview } = await import("@/lib/modelRenderer");
    const render = file.arrayBuffer().then((data) => renderModelPreview(data, format));
    return await Promise.race([render, new Promise<undefined>((resolve) => setTimeout(resolve, 30_000, undefined))]);
  } catch {
    return undefined;
  }
}

/** Concurrent attachment processing/uploads, bounding memory for large batches. */
const UPLOAD_CONCURRENCY = 3;
let uploadsActive = 0;
const uploadQueue: (() => void)[] = [];

function acquireUploadSlot(): Promise<void> {
  if (uploadsActive < UPLOAD_CONCURRENCY) {
    uploadsActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => uploadQueue.push(resolve));
}

function releaseUploadSlot(): void {
  const next = uploadQueue.shift();
  if (next) next();
  else uploadsActive--;
}

function fallbackLabel(url: string, mime: string): string {
  const last = url.split(/[?#]/)[0].split("/").pop() ?? "";
  // A content-addressed Blossom name is a 64-char hash; show the kind instead.
  if (last && !/^[0-9a-f]{64}(\.|$)/i.test(last)) {
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  }
  const kind = mime.split("/")[0];
  const ext = extForMime(mime);
  return `${kind === "image" || kind === "video" || kind === "audio" ? kind : "file"}${ext}`;
}

function pollOptionId(): string {
  return Math.random().toString(36).slice(2, 8);
}

interface Draft {
  content: string;
  /** Uploaded attachments as [url, NIP-94 tags] entries (Blossom URLs). */
  attachments: [string, string[][]][];
}

const EMPTY_DRAFT: Draft = { content: "", attachments: [] };

/**
 * Per-channel drafts in ArmadaDB's KV behind a synchronous cache (unbounded,
 * sensitive: plaintext + `decryption-key` imeta; covered by the logout purge).
 */
const draftCache = new KvPrefixCache<Partial<Draft>>({ prefix: "draft:" });

function readDraft(key: string): Draft {
  const stored = draftCache.get(key);
  if (typeof stored !== "object" || stored === null) return EMPTY_DRAFT;
  return {
    content: typeof stored.content === "string" ? stored.content : "",
    attachments: Array.isArray(stored.attachments) ? stored.attachments : [],
  };
}

function writeDraft(key: string, content: string, attachments: Map<string, string[][]>): void {
  if (content.trim() || attachments.size > 0) {
    draftCache.set(key, { content, attachments: [...attachments] });
  } else {
    draftCache.delete(key);
  }
}

interface PendingUpload {
  id: string;
  /** Tray slot, so a card keeps its place when its upload lands. */
  seq: number;
  name: string;
  /** Object URL of the picked image, previewed while uploading. Revoked when it settles. */
  previewUrl?: string;
  phase: "processing" | "uploading";
  progress?: number;
}

/** A gallery item whose content:// bytes are read lazily, so its card appears at once. */
interface DeferredFile {
  name: string;
  type: string;
  /** Known up front, so an oversize item is refused unread. */
  size?: number;
  load: () => Promise<File>;
}

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
  messages: NostrRumor[];
  replyTo?: NostrRumor;
  onCancelReply?: () => void;
  /**
   * An encrypted plane (Concord, DMs): no NIP-18 embed `q`s and no relay hint on
   * the reply `q`. Inline replies are a NIP-C7 `q` everywhere (CORD-03 §3);
   * Buzz never sets `replyTo` (replying is threading).
   */
  sealed?: boolean;
  onSent?: () => void;
  /**
   * Android Direct Share name/avatar for this room (see `lib/shareTargets`). Only
   * for rooms the publisher can't resolve (Concord, NIP-29); DMs resolve live.
   * Scalars so send-callback deps don't churn.
   */
  shareLabel?: string;
  shareIconUrl?: string;
  /**
   * Send via this callback instead of publishing a NIP-29 kind-9 (DMs, Concord).
   * `tags` carries the content-derived emoji/imeta/mention/reply tags. Hides poll
   * mode unless {@link onPollSubmit} is given. Resolving means "sent".
   */
  sendOverride?: (finalText: string, tags: string[][]) => Promise<void>;
  /**
   * Pre-flight refusal checked BEFORE the composer clears (Concord's send rate
   * limit), returning a toast reason or null. Call exactly ONCE per real send:
   * refusals count against the sender.
   */
  canSend?: () => string | null;
  /**
   * Delegated poll publisher (Concord seals polls); re-enables poll mode under
   * `sendOverride`. NIP-29 omits it and publishes to its host relay.
   */
  onPollSubmit?: (draft: PollDraft) => Promise<void>;
  /**
   * Explicit @-mention candidates for DM-mode composers that have a roster
   * (Concord). Provided (even empty) enables mentions; omit to disable (plain DMs).
   */
  mentionPubkeys?: string[];
  canMentionEveryone?: boolean;
  placeholder?: string;
  /** Extra draft-key fragment (e.g. a thread root id) when composers share a group. */
  draftScope?: string;
  /**
   * The room path shares are routed to. Passed in, not read from the location:
   * during a route transition several composers are mounted and each sees the
   * destination path. Omit where the composer isn't a share destination.
   */
  shareRoute?: string;
  /** Optimistic-send hooks (group mode): insert as `pending` on sign, then confirm or fail. */
  onOptimisticInsert?: (event: NostrEvent) => void;
  onOptimisticSent?: (id: string) => void;
  onOptimisticFailed?: (id: string) => void;
  canModerate?: boolean;
  /** Focus on mount and conversation switch; on non-touch, catch stray printable keys. */
  autoFocus?: boolean;
  /** Fired (unthrottled) as the user types; the caller throttles + publishes a typing signal. */
  onTyping?: () => void;
  /** Slash-command moderation (e.g. /kick, /ban), delegated to the caller. */
  onSlashAction?: (action: SlashAction) => void | Promise<void>;
  /**
   * Encrypt attachments (AES-256-GCM) before Blossom upload, Vector/0xChat-style:
   * key/nonce ride in `imeta` (`decryption-key`/`decryption-nonce`). Used by Concord.
   */
  encryptAttachments?: boolean;
  /**
   * Offer bot commands to a roster. An invocation carries a `["bot", <pubkey>]`
   * tag, so this must stay OFF where tags are plaintext (NIP-04 DMs) — it would
   * publish who commands which bot. For 1:1 bot DMs use {@link botDmPeer}.
   */
  botCommands?: boolean;
  /**
   * A 1:1 DM counterparty that may be a bot: enables its `/` commands, sent as
   * plain content with NO routing tag (the recipient IS the bot), so it's leak-free.
   */
  botDmPeer?: string;
  /** Recent speakers, most recent first, for `user` argument pickers. Concord supplies it; NIP-29 derives it. */
  recentAuthors?: string[];
  /**
   * Extra relays to search for bot manifests (a bot may publish only to its
   * community). Concord (`relayUrl="dm"`) must supply these.
   */
  conversationRelays?: string[];
  /** Offer NIP-88 polls (kind 1068). Buzz relays don't accept them. */
  pollsEnabled?: boolean;
  /**
   * Kind the group-publish path signs (default 9). Buzz forums use 45001, since
   * kind 9 is filtered out of the forum timeline. Ignored with `sendOverride`.
   */
  messageKind?: number;
  /**
   * ArrowUp in an EMPTY composer: open an inline edit of the user's last message.
   * Return true if handled (the key is swallowed).
   */
  onEditLast?: () => boolean;
  /**
   * `bar`: one-line chat composer, Enter sends. `document`: forum-style editor
   * above its toolbar, Enter is a newline, Ctrl/Cmd+Enter sends, labelled button.
   */
  layout?: "bar" | "document";
  /** Document layout only: Enter follows the send-on-Enter setting, as in chat. */
  documentEnterSends?: boolean;
  submitLabel?: string;
  /** Document layout only: a Cancel button (and Escape from an empty box). */
  onCancel?: () => void;
}

/**
 * Rich chat composer: mentions, shortcodes, pickers, uploads with NIP-92 imeta,
 * voice, NIP-88 polls, replies, NIP-18 quotes, drafts. With `sendOverride` it
 * doubles as a generic composer (DMs, Concord).
 */
export function ChatComposer({ relayUrl, groupId, messages, replyTo, onCancelReply, sealed = false, onSent, shareLabel, shareIconUrl, sendOverride, canSend, mentionPubkeys, canMentionEveryone = false, placeholder, draftScope, shareRoute, onOptimisticInsert, onOptimisticSent, onOptimisticFailed, canModerate = false, autoFocus = false, onTyping, onSlashAction, encryptAttachments = false, botCommands = false, botDmPeer, recentAuthors, conversationRelays, pollsEnabled = true, onPollSubmit, messageKind = KIND_GROUP_CHAT, onEditLast, layout = "bar", documentEnterSends = false, submitLabel = "Post", onCancel }: ChatComposerProps) {
  const isDocument = layout === "document";
  const { user } = useCurrentUser();
  const composerBoundsRef = useComposerBoundsRef();
  const { mutateAsync: createEvent, isPending: isSending } = useNostrPublish();
  const { mutateAsync: uploadFile } = useUploadFile();
  const preflightUpload = useUploadPreflight();
  const { emojis: customEmojis } = useCustomEmojis();
  const { toast } = useToast();
  const { config } = useAppContext();
  const isMobile = useIsMobile();
  const isTouch = useIsTouch();
  const enterSends = sendsOnEnter(config.sendOnEnter, isTouch);
  // Undefined in DMs (no scope).
  const appScope = useChatScope();
  const { launchApp } = useApps();

  // Mentions scoped to the room; disabled in plain DMs unless `mentionPubkeys` is given.
  const isDM = relayUrl === "dm";
  const { data: groupDetails } = useGroup(isDM ? undefined : relayUrl, isDM ? undefined : groupId);
  const memberPubkeys = useMemo(() => {
    if (mentionPubkeys) return mentionPubkeys;
    if (isDM) return undefined;
    const set = new Set<string>();
    for (const a of groupDetails?.admins ?? []) set.add(a.pubkey);
    for (const m of groupDetails?.members ?? []) set.add(m);
    for (const m of messages) set.add(m.pubkey);
    if (user) set.add(user.pubkey);
    return [...set];
  }, [mentionPubkeys, isDM, groupDetails?.admins, groupDetails?.members, messages, user]);
  const mentionsEnabled = memberPubkeys !== undefined;

  // Group-only commands (/poll, /thread, /kick, /ban) need the group publish path;
  // universal ones work everywhere.
  const slashCapabilities = useMemo(() => {
    const caps = new Set<SlashCapability>();
    if ((!sendOverride || onPollSubmit) && pollsEnabled) caps.add("poll");
    if (onSlashAction) {
      caps.add("thread");
      if (canModerate) caps.add("moderation");
    }
    return caps;
  }, [sendOverride, pollsEnabled, onPollSubmit, onSlashAction, canModerate]);

  // No prefix in the id: the cache adds `draft:`.
  const draftKey = `${relayUrl}:${groupId}${draftScope ? `:${draftScope}` : ""}`;

  const [content, setContent] = useState(() => readDraft(draftKey).content);

  // Bot commands (kind-10304 manifests). Explicit opt-in only (`botCommands` /
  // `botDmPeer`), never inferred from the roster: routing tags must not reach a
  // transport that can't hide them.
  const [botCommand, setBotCommand] = useState<BotCommandEntry | null>(null);
  /** The bot the user picked from, so a name two bots share still routes correctly. */
  const armedBotRef = useRef<string | undefined>(undefined);
  // Concord rides the "dm" sentinel and hands in its community's relays.
  const botRelays = useMemo(
    () => conversationRelays ?? (isDM ? undefined : [relayUrl]),
    [conversationRelays, isDM, relayUrl],
  );
  const botRoster = useMemo(
    () => (botDmPeer ? [botDmPeer] : memberPubkeys),
    [botDmPeer, memberPubkeys],
  );
  const botCommandsEnabled = botCommands || botDmPeer !== undefined;
  const {
    entries: botEntries,
    bots: botPubkeys,
    profiles: botProfiles,
    isLoading: botsLoading,
  } = useBotManifests(botCommandsEnabled ? botRoster : undefined, botRelays);

  const recentAuthorsResolved = useMemo(
    () => recentAuthors ?? authorsByRecency(messages),
    [recentAuthors, messages],
  );

  const botRecentsKey = `armada-bot-recents:${user?.pubkey ?? ""}`;
  const [botRecents, setBotRecents] = useState<string[]>([]);
  useEffect(() => {
    setBotRecents(readBotRecents(botRecentsKey));
  }, [botRecentsKey]);
  const rememberBotCommand = useCallback((bot: string, name: string) => {
    const key = `${bot}:${name}`;
    setBotRecents((prev) => {
      const next = [key, ...prev.filter((k) => k !== key)].slice(0, BOT_RECENTS_CAP);
      try {
        localStorage.setItem(botRecentsKey, JSON.stringify(next));
      } catch {
        // Storage may be unavailable (private mode); recents are a nicety.
      }
      return next;
    });
  }, [botRecentsKey]);

  const [pickerOpen, setPickerOpen] = useState(false);
  const { mounted: pickerMounted, visible: pickerVisible } = useMountedTransition(pickerOpen);
  const [pickerTab, setPickerTab] = useState<"emoji" | "gif" | "stickers" | "games">("emoji");
  const [plusOpen, setPlusOpen] = useState(false);
  const [removedEmbeds, setRemovedEmbeds] = useState<Set<string>>(new Set());
  const [uploadedFileGroups, setUploadedFileGroups] = useState<Map<string, string[][]>>(
    () => new Map(readDraft(draftKey).attachments),
  );
  /**
   * Per-upload AES-GCM params, keyed by ciphertext URL. A ref, never persisted:
   * these are secrets, so encrypted attachments aren't restorable from drafts.
   * `ox` is absent on forwards whose sender omitted it.
   */
  const attachmentEncryption = useRef<Map<string, ImetaEncryption & { ox?: string }>>(new Map());
  /** Tray slot in PICK order (uploads finish in any order); also the send order. */
  const attachmentSeq = useRef<Map<string, number>>(new Map());
  const nextSeq = useRef(0);
  /** Local-only filename per URL (not sent: it can carry a date or place). */
  const attachmentMeta = useRef<Map<string, { name: string }>>(new Map());
  /**
   * A forward's `imeta`/`emoji` tags, carried verbatim so attachments aren't
   * re-uploaded and encrypted ones keep their key. A ref, like
   * `attachmentEncryption`, so keys never reach a draft.
   */
  const forwardedContentTags = useRef<string[][]>([]);
  /**
   * In-flight attachments, added on pick so the card shows through slow local
   * work (resize, transcode, encrypt) before the upload starts.
   */
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  /** Abort per pending id; a ref so cancel isn't a side effect inside an updater. */
  const pendingAborts = useRef(new Map<string, AbortController>());
  /** Block sending mid-upload, or the text would publish without the file. */
  const isUploading = pendingUploads.length > 0;

  const [mode, setMode] = useState<"post" | "poll">("post");
  const pollMode = mode === "poll";
  const { mounted: pollMounted, visible: pollVisible } = useMountedTransition(pollMode);
  const [pollOptions, setPollOptions] = useState([
    { id: pollOptionId(), label: "" },
    { id: pollOptionId(), label: "" },
  ]);
  const [pollType, setPollType] = useState<"singlechoice" | "multiplechoice">("singlechoice");
  const [pollDuration, setPollDuration] = useState<7 | 3 | 1 | 0>(7);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const pickerToggleGroupRef = useRef<HTMLDivElement>(null);
  const { insertAtCursor, insertEmoji } = useInsertText(textareaRef, content, setContent);
  // `:name:` of a custom emoji is that emoji, so auto-conversion leaves it be.
  const customShortcodes = useMemo(() => new Set(customEmojis.map((e) => e.shortcode)), [customEmojis]);

  const togglePickerTab = useCallback((tab: "emoji" | "gif") => {
    if (pickerOpen && pickerTab === tab) {
      setPickerOpen(false);
      return;
    }
    setPickerTab(tab);
    setPickerOpen(true);
  }, [pickerOpen, pickerTab]);

  useMentionInsertions((text) => {
    insertEmoji(text);
    textareaRef.current?.focus();
  });

  const voiceRecorder = useVoiceRecorder();
  const [isPublishingVoice, setIsPublishingVoice] = useState(false);

  // Gates the persist effect: a cold composer's empty draft would DELETE the stored one.
  const [draftsReady, setDraftsReady] = useState(() => draftCache.warmed);
  useEffect(() => {
    let cancelled = false;
    void draftCache.ready().then(() => {
      if (!cancelled) setDraftsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const draft = readDraft(draftKey);
    setContent(draft.content);
    setUploadedFileGroups(new Map(draft.attachments));
    setRemovedEmbeds(new Set());
    setMode("post");
    // A half-built command must not follow a channel switch (the composer isn't
    // remounted) and fire its routing tag into the wrong conversation.
    setBotCommand(null);
    armedBotRef.current = undefined;

    // Fill in after the cache warms, but only untouched fields.
    let cancelled = false;
    void draftCache.ready().then(() => {
      if (cancelled) return;
      const warmed = readDraft(draftKey);
      if (!warmed.content && warmed.attachments.length === 0) return;
      setContent((prev) => (prev ? prev : warmed.content));
      setUploadedFileGroups((prev) => (prev.size > 0 ? prev : new Map(warmed.attachments)));
    });
    return () => {
      cancelled = true;
    };
  }, [draftKey]);

  // Auto-resize, also on viewport resize (the font shrinks at `md:`). The
  // `height: auto` probe re-lays-out the whole pane, so skip it for an empty
  // field (cached per layout) and for append-only edits (compare `scrollHeight`).
  const measuredContentRef = useRef<string | null>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const previous = measuredContentRef.current;
    measuredContentRef.current = content;
    const bounds = () => ({
      max: layout === "document" ? Math.max(240, Math.round(window.innerHeight * 0.5)) : 160,
      min: layout === "document" ? 120 : 0,
    });
    // The wrapper is held at its height during the probe: a collapsed composer
    // would grow the timeline for the forced layout and clamp its scrollTop.
    const measure = () => {
      const { max, min } = bounds();
      const box = el.parentElement;
      const held = box?.style.height ?? "";
      if (box) box.style.height = `${box.offsetHeight}px`;
      el.style.height = "auto";
      const height = Math.min(Math.max(el.scrollHeight, min), max);
      el.style.height = `${height}px`;
      if (box) box.style.height = held;
      return height;
    };
    const emptyKey = `${layout}:${window.innerWidth >= MD_BREAKPOINT_PX}:${window.innerHeight}`;
    const set = parseFloat(el.style.height);
    if (content === "") {
      const known = emptyHeights.get(emptyKey);
      if (known !== undefined) el.style.height = `${known}px`;
      else emptyHeights.set(emptyKey, measure());
    } else if (previous !== null && content.startsWith(previous) && Number.isFinite(set)) {
      const { max, min } = bounds();
      const needed = Math.min(Math.max(el.scrollHeight, min), max);
      if (needed > set) el.style.height = `${needed}px`;
    } else {
      measure();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [content, layout]);

  // Deferred a frame: a context menu still trapping focus would pull it back.
  useEffect(() => {
    if (!replyTo) return;
    const frame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [replyTo]);

  // Clear a pending reply on a real conversation switch (keyed on scope; the
  // handler comes from a ref since it's a fresh closure each render).
  const onCancelReplyRef = useRef(onCancelReply);
  onCancelReplyRef.current = onCancelReply;
  useEffect(() => {
    onCancelReplyRef.current?.();
  }, [relayUrl, groupId]);

  // Keep focus in a field/dialog that holds it, and after keyboard channel navigation.
  useEffect(() => {
    if (!autoFocus) return;
    const frame = requestAnimationFrame(() => {
      if (!mayFocusOnSwitch(textareaRef.current)) return;
      textareaRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [autoFocus, relayUrl, groupId]);

  // Type-to-focus. Not on touch, where focusing raises the soft keyboard.
  useEffect(() => {
    if (!autoFocus || isTouch) return;
    return registerTypeToFocus(textareaRef);
  }, [autoFocus, isTouch]);

  useEffect(() => {
    if (!pickerOpen) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (pickerRef.current?.contains(target)) return;
      if (pickerToggleGroupRef.current?.contains(target)) return;
      setPickerOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [pickerOpen]);

  // Back closes the picker, not the conversation behind it.
  useAndroidBack(() => {
    setPickerOpen(false);
    return true;
  }, pickerOpen, "overlay");

  // Debounced draft save. Encrypted attachments are dropped: their params live
  // only in memory, so a restored ciphertext URL would be undecryptable.
  useEffect(() => {
    // An empty composer writes a CLEAR, which would delete the draft still loading.
    if (!draftsReady) return;
    const timer = setTimeout(() => {
      // Keyed on having params, not this surface encrypting: forwards arrive encrypted.
      const persistable = new Map(
        [...uploadedFileGroups].filter(([url]) => !attachmentEncryption.current.has(url)),
      );
      writeDraft(draftKey, content, persistable);
    }, 300);
    return () => clearTimeout(timer);
  }, [content, uploadedFileGroups, draftKey, draftsReady]);

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

  const attachments = useMemo(
    () =>
      Array.from(uploadedFileGroups.entries()).map(([url, tags]) => {
        const mime = tags.find((t) => t[0] === "m")?.[1] ?? "";
        // Encrypted attachments are decrypted for preview like the receive side.
        const enc = attachmentEncryption.current.get(url);
        const encryption = enc
          ? { algorithm: enc.algorithm, key: enc.key, nonce: enc.nonce }
          : undefined;
        // Lets the lightbox size and blur-up its placeholder.
        const dim = tags.find((t) => t[0] === "dim")?.[1];
        const blurhash = tags.find((t) => t[0] === "blurhash")?.[1];
        const summary = tags.find((t) => t[0] === "summary")?.[1];
        const name = tags.find((t) => t[0] === "name")?.[1];
        // Poster frame shares the video's key and nonce when encrypted.
        const icon = tags.find((t) => t[0] === "image" || t[0] === "thumb")?.[1];
        const isWebxdc = isWebxdcMime(mime);
        const local = attachmentMeta.current.get(url);
        return {
          url,
          mime,
          name: summary ?? name,
          // An image sends no `name`, and a Blossom URL is only a hash.
          label: summary ?? local?.name ?? name ?? fallbackLabel(url, mime),
          alt: tags.find((t) => t[0] === "alt")?.[1] || undefined,
          spoiler: tags.some((t) => t[0] === "content-warning"),
          icon,
          isImage: mime.startsWith("image/"),
          isVideo: mime.startsWith("video/"),
          isAudio: mime.startsWith("audio/"),
          isWebxdc,
          encryption,
          dim,
          blurhash,
        };
      })
        // Stable: items without a slot (restored drafts) keep their order, first.
        .sort((a, b) => (attachmentSeq.current.get(a.url) ?? -1) - (attachmentSeq.current.get(b.url) ?? -1)),
      [uploadedFileGroups],
    );

  const galleryAttachments = useMemo(
    () =>
      attachments
        .filter((att) => att.isImage || att.isVideo)
        .map(({ url, mime, encryption, dim, blurhash, icon, isVideo }) => ({
          url,
          mime,
          encryption,
          dim,
          blurhash,
          poster: isVideo ? icon : undefined,
        })),
    [attachments],
  );

  // Tracked by URL so removing the open attachment closes the lightbox.
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const lightboxIndex = lightboxUrl
    ? galleryAttachments.findIndex((item) => item.url === lightboxUrl)
    : -1;
  const closeLightbox = useCallback(() => setLightboxUrl(null), []);
  const stepLightbox = useCallback(
    (delta: number) => {
      setLightboxUrl((prev) => {
        if (prev === null) return prev;
        const at = galleryAttachments.findIndex((item) => item.url === prev);
        if (at === -1) return null;
        const len = galleryAttachments.length;
        return galleryAttachments[(at + delta + len) % len].url;
      });
    },
    [galleryAttachments],
  );
  const lightboxNext = useCallback(() => stepLightbox(1), [stepLightbox]);
  const lightboxPrev = useCallback(() => stepLightbox(-1), [stepLightbox]);

  const removeAttachment = useCallback((url: string) => {
    setUploadedFileGroups((prev) => {
      const next = new Map(prev);
      next.delete(url);
      return next;
    });
    attachmentEncryption.current.delete(url);
    attachmentMeta.current.delete(url);
    attachmentSeq.current.delete(url);
    setContent((prev) =>
      prev
        .split("\n")
        .filter((line) => line.trim() !== url)
        .join("\n"),
    );
  }, []);

  /**
   * Set an attachment's `alt` and spoiler (`content-warning`); both live in its
   * tags, so they ride the draft.
   */
  const updateAttachment = useCallback((url: string, patch: { alt?: string; spoiler?: boolean }) => {
    setUploadedFileGroups((prev) => {
      const tags = prev.get(url);
      if (!tags) return prev;
      let next = tags;
      if (patch.alt !== undefined) {
        const alt = patch.alt.replace(/\s+/g, " ").trim().slice(0, MAX_ALT_CHARS);
        next = next.filter((t) => t[0] !== "alt");
        if (alt) next = [...next, ["alt", alt]];
      }
      if (patch.spoiler !== undefined) {
        next = next.filter((t) => t[0] !== "content-warning");
        if (patch.spoiler) next = [...next, ["content-warning", "spoiler"]];
      }
      return new Map(prev).set(url, next);
    });
  }, []);

  /** Register a GIF/sticker URL as an attachment chip rather than pasting it. */
  const registerAttachment = useCallback((url: string, fallbackMime: string, dim?: string) => {
    const ext = url.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
    const extMime = mimeFromExt(ext);
    const mime = extMime === "application/octet-stream" ? fallbackMime : extMime;
    const tags: string[][] = [["url", url], ["m", mime]];
    if (dim) tags.push(["dim", dim]);
    if (!attachmentSeq.current.has(url)) attachmentSeq.current.set(url, nextSeq.current++);
    setUploadedFileGroups((prev) => new Map(prev).set(url, keepUserFields(prev.get(url), tags)));
  }, []);

  /**
   * Attach a discovered webxdc game (kind 1063). A fresh topic makes this
   * message's copy its own shared session. Public URL, not re-uploaded.
   */
  const registerGame = useCallback(async (app: WebxdcApp) => {
    const topic = mintTopicId(app.url, user?.pubkey ?? "");
    const tags: string[][] = [
      ["url", app.url],
      ["m", WEBXDC_MIME],
      // Written twice: `webxdc-topic` is what Vector reads; `webxdc` is Armada's
      // legacy field.
      ["webxdc-topic", topic],
      ["webxdc", topic],
      ["summary", app.name],
      // A filename: receivers name the saved file from it. `summary` is the display title.
      ["name", /\.xdc$/i.test(app.name) ? app.name : `${app.name}.xdc`],
    ];
    if (app.icon) tags.push(["image", app.icon], ["thumb", app.icon]);
    attachmentSeq.current.set(app.url, nextSeq.current++);
    setUploadedFileGroups((prev) => new Map(prev).set(app.url, tags));
    setPickerOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [user?.pubkey]);

  const resetComposeState = useCallback(() => {
    setContent("");
    setPickerOpen(false);
    setRemovedEmbeds(new Set());
    setUploadedFileGroups(new Map());
    attachmentEncryption.current.clear();
    attachmentMeta.current.clear();
    attachmentSeq.current.clear();
    forwardedContentTags.current = [];
    setLightboxUrl(null);
    setMode("post");
    setPollOptions([{ id: pollOptionId(), label: "" }, { id: pollOptionId(), label: "" }]);
    setPollType("singlechoice");
    setPollDuration(7);
    draftCache.delete(draftKey);
    onCancelReply?.();
    // Clicking send otherwise drops focus.
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [draftKey, onCancelReply]);

  const handleFileUpload = useCallback(async (source: File | DeferredFile, options: { spoiler?: boolean } = {}) => {
    const tooLarge = (description: string) =>
      toast({ title: "File too large", description, variant: "destructive" });
    const refused = (refusal: { status: number; reason?: string }) =>
      toast({ title: "Can't upload this file", description: describeRefusal(refusal), variant: "destructive" });
    const limitMb = (bytes: number) => Math.round(bytes / (1024 * 1024));
    const encryptedLimitMessage = (bytes: number) =>
      `Encrypted attachments are limited to ${limitMb(bytes)} MB on this device, since they are sealed and opened in memory.`;

    // Refuse oversize before reading (content:// reads buffer the whole file).
    // Only the device limit applies; the server decides upload size.
    const pickedMime = mimeOfPicked(source.name, source.type);
    const pickedLimit = deviceInputLimit(pickedMime, encryptAttachments);
    if (source.size !== undefined && pickedLimit !== undefined && source.size > pickedLimit) {
      tooLarge(encryptedLimitMessage(pickedLimit));
      return;
    }

    const pendingId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const seq = nextSeq.current++;
    const abort = new AbortController();
    let previewUrl = source instanceof File && source.type.startsWith("image/") && source.size < 40 * 1024 * 1024
      ? URL.createObjectURL(source)
      : undefined;
    setPendingUploads((prev) => [
      ...prev,
      { id: pendingId, seq, name: source.name || "file", previewUrl, phase: "processing" },
    ]);
    pendingAborts.current.set(pendingId, abort);

    const patchPending = (patch: Partial<PendingUpload>) => {
      setPendingUploads((prev) => prev.map((p) => (p.id === pendingId ? { ...p, ...patch } : p)));
    };

    let slotHeld = false;
    try {
      // A card cancelled while waiting for a slot hands the slot straight back.
      const slot = acquireUploadSlot();
      const cancelled = new Promise<"cancelled">((resolve) =>
        abort.signal.addEventListener("abort", () => resolve("cancelled"), { once: true }));
      if (await Promise.race([slot.then(() => "slot" as const), cancelled]) === "cancelled") {
        void slot.then(releaseUploadSlot);
        return;
      }
      slotHeld = true;
      const file = source instanceof File ? source : await source.load();
      if (abort.signal.aborted) return;
      if (!previewUrl && file.type.startsWith("image/") && file.size < 40 * 1024 * 1024) {
        previewUrl = URL.createObjectURL(file);
        patchPending({ previewUrl });
      }

      // Browsers report "" for some containers (`.avi`), so fall back to the extension.
      // A 3D model's extension always wins: browsers report nothing or nonsense for them.
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      const modelMime = modelMimeFromExt(ext);
      const mime = modelMime ?? (file.type || mimeFromExt(ext));
      const model = modelFormat(mime);
      const isImage = mime.startsWith("image/");
      const isVideo = mime.startsWith("video/");
      const isAudio = mime.startsWith("audio/");
      const isMedia = isImage || isVideo || isAudio;

      const inputLimit = deviceInputLimit(mime, encryptAttachments);
      if (inputLimit !== undefined && file.size > inputLimit) {
        tooLarge(encryptedLimitMessage(inputLimit));
        return;
      }

      // BUD-06: ask the servers now for files processing can't shrink. Encryption
      // adds only a 16-byte tag.
      if (!isImage && !isVideo) {
        const refusal = await preflightUpload(
          { size: file.size + (encryptAttachments ? 16 : 0), type: mime },
          abort.signal,
        );
        if (abort.signal.aborted) return;
        if (refusal) {
          refused(refusal);
          return;
        }
      }

      // Re-typed so the upload's Content-Type and the encrypted path's `m` carry it.
      let uploadableFile = modelMime && file.type !== modelMime
        ? new File([file], file.name, { type: modelMime, lastModified: file.lastModified })
        : file;
      let resizedDim: string | undefined;
      let video: ProcessedVideo | undefined;
      let audio: AudioMetadata | undefined;
      let audioWaveform: Promise<number[] | undefined> | undefined;
      let modelStill: Blob | undefined;

      if (isImage) {
        const resized = await resizeImage(file);
        uploadableFile = resized.file;
        resizedDim = resized.dimensions;
      } else if (isVideo) {
        // Never throws for media reasons (falls back to the original). Progress is
        // patched per whole percent to limit re-renders.
        let lastPercent = -1;
        video = await processVideo(file, {
          signal: abort.signal,
          onProgress: (progress) => {
            const percent = Math.floor(progress * 100);
            if (percent === lastPercent) return;
            lastPercent = percent;
            patchPending({ progress });
          },
        });
        uploadableFile = video.file;
      } else if (isAudio) {
        // Tags/cover shown on the card only (recipients read the same bytes); the
        // waveform decodes alongside the upload.
        audioWaveform = computeWaveform(file);
        audio = await readAudioMetadata(file);
        if (audio.cover && !previewUrl && !abort.signal.aborted) {
          previewUrl = URL.createObjectURL(audio.cover);
          patchPending({ previewUrl });
        }
      } else if (model) {
        modelStill = await renderModelStill(file, model);
        if (modelStill && !previewUrl && !abort.signal.aborted) {
          previewUrl = URL.createObjectURL(modelStill);
          patchPending({ previewUrl });
        }
      }

      if (abort.signal.aborted) return;
      // Sealing holds plaintext and ciphertext at once, so check the device limit
      // on the processed size.
      if (encryptAttachments && uploadableFile.size > MAX_ENCRYPTED_BYTES) {
        tooLarge(
          isVideo
            ? `${encryptedLimitMessage(MAX_ENCRYPTED_BYTES)} This video couldn't be compressed under it.`
            : encryptedLimitMessage(MAX_ENCRYPTED_BYTES),
        );
        return;
      }
      if (isImage || isVideo) {
        const refusal = await preflightUpload(
          {
            size: uploadableFile.size + (encryptAttachments ? 16 : 0),
            // The ciphertext is uploaded under the plaintext's type.
            type: uploadableFile.type || mime,
          },
          abort.signal,
        );
        if (abort.signal.aborted) return;
        if (refusal) {
          refused(refusal);
          return;
        }
      }
      patchPending({ phase: "uploading", progress: undefined });

      // dim/blurhash from the PLAINTEXT, not the ciphertext.
      let dimTag = resizedDim ?? video?.dim;
      let blurhashTag: string | undefined = video?.blurhash;
      if (isImage) {
        const meta = await getImageMeta(uploadableFile);
        if (!dimTag && meta.dim) dimTag = meta.dim;
        blurhashTag = meta.blurhash || undefined;
      }
      const originalMime = uploadableFile.type || mime;

      // Poster frame or model still: a second blob, referenced as `image`/`thumb`.
      let posterFile = video?.poster
        ? new File([video.poster], replaceExtension(uploadableFile.name, ".jpg"), { type: "image/jpeg" })
        : modelStill
          ? new File([modelStill], replaceExtension(uploadableFile.name, ".png"), { type: "image/png" })
          : undefined;

      // The plaintext, kept to render the upload locally (see primeAttachment).
      const plainFile = uploadableFile;
      const plainPoster = posterFile;
      let encryption: (ImetaEncryption & { ox: string }) | undefined;
      if (encryptAttachments) {
        const enc = await encryptFileForUpload(uploadableFile);
        uploadableFile = enc.file;
        encryption = { algorithm: "aes-gcm", key: enc.key, nonce: enc.nonce, ox: enc.originalHash };

        if (posterFile) {
          // NIP-17: a `thumb` uses the same key and nonce as its file.
          posterFile = (await encryptFileWithParams(posterFile, enc.key, enc.nonce)).file;
        }
      }

      // Poster first: small, and its failure mustn't cost the file.
      let posterUrl: string | undefined;
      if (posterFile) {
        try {
          posterUrl = (await uploadFile({ file: posterFile, signal: abort.signal }))[0][1];
        } catch {
          posterUrl = undefined;
        }
      }

      const tags = await uploadFile({ file: uploadableFile, signal: abort.signal });
      const url = tags[0][1];
      // Under the inline-decrypt cap only: past it a render wouldn't download it either.
      if (plainFile.size <= MAX_DECRYPT_BYTES) primeAttachment(url, encryption, plainFile);
      if (posterUrl && plainPoster) primeAttachment(posterUrl, encryption, plainPoster);

      // Encrypted: server NIP-94 fields describe the ciphertext; restore the real `m`.
      // Likewise a model: servers type what they don't recognise as octet-stream.
      if ((encryption || modelMime) && originalMime) {
        const mTag = tags.find((t) => t[0] === "m");
        if (mTag) mTag[1] = originalMime;
        else tags.push(["m", originalMime]);
      }

      const hasTag = (name: string) => tags.some((t) => t[0] === name);
      if (isImage || isVideo) {
        // Ours wins: the server's `dim` describes the pre-transcode file or ciphertext.
        if (dimTag) {
          const dim = tags.find((t) => t[0] === "dim");
          if (dim) dim[1] = dimTag;
          else tags.push(["dim", dimTag]);
        }
        if (blurhashTag && !hasTag("blurhash")) tags.push(["blurhash", blurhashTag]);
      }
      if (video?.duration && !hasTag("duration")) tags.push(["duration", String(video.duration)]);
      if (posterUrl) {
        // NIP-94 defines both; clients differ on which they read.
        tags.push(["image", posterUrl], ["thumb", posterUrl]);
      }
      if (!isMedia) {
        // Download cards need the filename and plaintext size (the server's describes ciphertext).
        if (file.name && !hasTag("name")) tags.push(["name", file.name]);
        const sizeTag = tags.find((t) => t[0] === "size");
        if (sizeTag) sizeTag[1] = String(file.size);
        else tags.push(["size", String(file.size)]);
      } else if (isVideo && file.name && !hasTag("name")) {
        // Non-inline containers (AVI/FLV/WMV) render as download cards; `size` is left
        // to the server since a transcode changed it.
        tags.push(["name", file.name]);
      }

      // Browsers report no type for `.xdc`: force `m`, mint a session, and read the
      // manifest title so it renders as a launchable card.
      if (isWebxdcMime(originalMime) || /\.xdc$/i.test(file.name)) {
        const mTag = tags.find((t) => t[0] === "m");
        if (mTag) mTag[1] = WEBXDC_MIME;
        else tags.push(["m", WEBXDC_MIME]);
        const topic = mintTopicId(file.name, user?.pubkey ?? "");
        tags.push(["webxdc-topic", topic], ["webxdc", topic]);
        try {
          const meta = await extractWebxdcMeta(file);
          if (meta.name) tags.push(["summary", meta.name]);
        } catch {
          // Unreadable archive — leave it as a plain attachment.
        }
      }

      const waveform = await audioWaveform;
      if (abort.signal.aborted) return;

      if (options.spoiler && (isImage || isVideo)) tags.push(["content-warning", "spoiler"]);

      if (encryption) attachmentEncryption.current.set(url, encryption);
      // An identical file already staged keeps its card's slot.
      if (!attachmentSeq.current.has(url)) attachmentSeq.current.set(url, seq);
      attachmentMeta.current.set(url, { name: file.name });
      if (audio) primeAudioMetadata(url, audio);
      if (audioWaveform) primeAudioWaveform(url, waveform);

      setUploadedFileGroups((prev) => new Map(prev).set(url, keepUserFields(prev.get(url), tags)));
    } catch (error) {
      if (!abort.signal.aborted) {
        toast({
          title: "Upload failed",
          // The server's X-Reason, when given.
          description: uploadFailureReason(error) ?? "Could not upload file.",
          variant: "destructive",
        });
      }
    } finally {
      if (slotHeld) releaseUploadSlot();
      pendingAborts.current.delete(pendingId);
      setPendingUploads((prev) => prev.filter((p) => p.id !== pendingId));
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    }
  }, [uploadFile, preflightUpload, toast, encryptAttachments, user?.pubkey]);

  const handleFiles = useCallback((files: Iterable<File | DeferredFile>, options?: { spoiler?: boolean }) => {
    for (const file of files) void handleFileUpload(file, options);
  }, [handleFileUpload]);

  const handleGalleryItems = useCallback((items: GalleryItem[], options: { spoiler: boolean }) => {
    handleFiles(items.map((item) => ({
      name: item.name ?? (item.video ? "video" : "image"),
      // Never empty: the size gate needs to know a video from an image.
      type: item.mime || (item.video ? "video/*" : "image/*"),
      size: item.size > 0 ? item.size : undefined,
      load: () => galleryItemFile(item),
    })), options);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [handleFiles]);

  /**
   * Strip tracking parameters (when enabled). Applied on share/forward arrival
   * and again on send, before anything reads the text — but before attachment
   * URLs are appended, since those match `imeta` by exact string.
   */
  const canonicalizeLinks = useCallback(
    (text: string) => (config.stripTrackingParams ? stripTrackingParamsInText(text) : text),
    [config.stripTrackingParams],
  );

  // Consume a share routed to THIS composer's `shareRoute` (not the pathname,
  // which the outgoing page also sees mid-transition). Subscribed, since native
  // file copies and Direct Share can arrive after mount.
  useEffect(() => {
    if (!shareRoute) return;
    const consume = () => {
      const share = consumeShareFor(shareRoute);
      if (!share) return;
      // Appended, not replaced: several forwards can stage into one draft;
      // buildMessageTags drops unreferenced ones.
      if (share.tags?.length) {
        forwardedContentTags.current = [...forwardedContentTags.current, ...share.tags];
      }
      // A forwarded attachment becomes a chip; its URL is stripped from the text
      // since send re-appends attachment URLs.
      const forwarded = (share.tags ?? [])
        .filter((t) => t[0] === "imeta")
        .map(forwardedAttachment)
        .filter((a): a is NonNullable<typeof a> => a !== null);
      if (forwarded.length) {
        for (const att of forwarded) {
          if (att.encryption) attachmentEncryption.current.set(att.url, att.encryption);
        }
        setUploadedFileGroups((prev) => {
          const next = new Map(prev);
          for (const att of forwarded) next.set(att.url, att.tags);
          return next;
        });
      }
      // Canonicalized on arrival so the user sees what they'll publish; after
      // removing attachment URLs, which must not be rewritten.
      const text = canonicalizeLinks(
        forwarded.length
          ? stripUrlsFromText(share.text, forwarded.map((a) => a.url))
          : share.text,
      );
      if (text) {
        setContent((cur) => (cur ? `${cur}\n${text}` : text));
      }
      textareaRef.current?.focus();
      handleFiles(share.files);
    };
    consume();
    return onShareStashChanged(consume);
  }, [handleFiles, shareRoute, canonicalizeLinks]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    // Non-file items fall through to default paste handling.
    const files = Array.from(items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);

    if (files.length === 0) return;
    e.preventDefault();
    handleFiles(files);
  }, [handleFiles]);

  const handleGlobalImagePaste = useCallback((files: File[]) => {
    textareaRef.current?.focus();
    handleFiles(files);
  }, [handleFiles]);
  const claimPasteOwnership = useGlobalImagePaste(handleGlobalImagePaste);

  // `dragDepth` tracks nested enter/leave so the overlay doesn't flicker.
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

  const handleDrop = useCallback((e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files ?? []);
    dragDepth.current = 0;
    setIsDragging(false);
    if (files.length === 0) return;
    e.preventDefault();
    handleFiles(files);
  }, [handleFiles]);

  const buildMessageTags = useCallback((finalContent: string): string[][] => {
    // NOTE: deliberately no NIP-29 `previous` tags: relay29 rejects events whose
    // first ref isn't in its last-50 ring, which a local snapshot often misses.
    // It's optional and only guards against relay forks.
    const tags: string[][] = [
      ["h", groupId],
    ];

    for (const t of new Set(extractHashtags(finalContent))) {
      tags.push(["t", t]);
    }

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

    // NIP-C7 `q` on every plane, ahead of any embed `q`. Always `p`-tag the author.
    if (replyTo) {
      tags.push(["q", replyTo.id, sealed ? "" : relayUrl, replyTo.pubkey]);
      if (replyTo.pubkey !== user?.pubkey && !mentionedPubkeys.has(replyTo.pubkey)) {
        tags.push(["p", replyTo.pubkey]);
      }
    }

    // NIP-18 embed `q`s only on public planes: a sealed rumor is never indexed.
    for (const embed of sealed ? [] : visibleEmbeds) {
      if (embed.type === "naddr" && embed.addr) {
        tags.push(["q", `${embed.addr.kind}:${embed.addr.pubkey}:${embed.addr.identifier}`]);
      } else if (embed.eventId) {
        tags.push(["q", embed.eventId, embed.relay ?? "", ...(embed.author ? [embed.author] : [])]);
      }
    }

    const emojiTags = collectEmojiTags(finalContent, customEmojis);
    tags.push(...emojiTags);

    // NIP-92 imeta, matched by EXACT upload URL: Blossom names blobs by canonical
    // extension (audio/mpeg → `.mpga`), and a missed imeta leaves encrypted blobs
    // undecryptable.
    const processedUrls = new Set<string>();
    for (const [url, fileTags] of uploadedFileGroups) {
      if (!finalContent.includes(url)) continue;
      processedUrls.add(url);
      const fields = fileTags.map((tag) => `${tag[0]} ${tag[1]}`);
      // Vector / 0xChat imeta decryption format.
      const enc = attachmentEncryption.current.get(url);
      if (enc) {
        fields.push(`encryption-algorithm ${enc.algorithm}`);
        fields.push(`decryption-key ${enc.key}`);
        fields.push(`decryption-nonce ${enc.nonce}`);
        // Absent on a forwarded attachment whose sender didn't include it.
        if (enc.ox) fields.push(`ox ${enc.ox}`);
      }
      tags.push(["imeta", ...fields]);
    }

    // BEFORE the extension pass and recorded in `processedUrls`: a later bare imeta
    // for the same URL would win and drop the decryption params.
    if (forwardedContentTags.current.length) {
      const forwarded = contentTagsFor(forwardedContentTags.current, finalContent, {
        urls: processedUrls,
        shortcodes: new Set(emojiTags.map(([, shortcode]) => shortcode)),
      });
      for (const tag of forwarded) {
        if (tag[0] === "imeta") {
          const url = tag.find((f) => f.startsWith("url "))?.slice(4);
          if (url) processedUrls.add(url);
        }
        tags.push(tag);
      }
    }

    // Typed/pasted media URLs get a basic extension-derived imeta.
    const mediaUrlMatches = finalContent.matchAll(new RegExp(IMETA_MEDIA_URL_REGEX.source, "gi"));
    for (const match of mediaUrlMatches) {
      const url = match[0];
      if (processedUrls.has(url)) continue;
      processedUrls.add(url);
      tags.push(["imeta", `url ${url}`, `m ${mimeFromExt(match[1].toLowerCase())}`]);
    }

    return tags;
  }, [groupId, user, replyTo, sealed, relayUrl, visibleEmbeds, customEmojis, uploadedFileGroups]);

  /**
   * Record this room in the Direct Share ledger. Room from the LOCATION
   * (`roomPath`), since Concord props can't reconstruct the route. Called at
   * dispatch, so it means "the user sent here", not "the relay accepted".
   */
  const noteSent = useCallback(() => {
    if (!user) return;
    const route = parseChatRoute(window.location.pathname);
    if (!route) return;
    recordSent(user.pubkey, roomPath(route), { label: shareLabel, iconUrl: shareIconUrl });
  }, [user, shareLabel, shareIconUrl]);

  /** `extraTags` carry routing the text can't express (the `bot` tag); sealed like the rest on Concord. */
  const publishMessage = useCallback(async (finalText: string, extraTags?: string[][]) => {
    if (!finalText || !user || finalText.length > MAX_CHARS) return;
    // Only the legacy publish path serializes on `isSending`; the others publish
    // in the background, serialized by the per-identity signer queue.
    if (!sendOverride && !onOptimisticInsert && isSending) return;

    // Refused before anything is built or cleared, so the draft survives.
    const refusal = canSend?.();
    if (refusal) {
      toast({ title: "Message not sent", description: refusal, variant: "destructive" });
      return;
    }

    // Build tags BEFORE reset: `resetComposeState` clears the encryption ref.
    const tags = buildMessageTags(finalText);
    if (extraTags?.length) tags.push(...extraTags);

    try {
      if (sendOverride) {
        // Fire-and-forget; the override serializes signing and reports delivery.
        resetComposeState();
        onSent?.();
        noteSent();
        void Promise.resolve(sendOverride(finalText, tags)).catch((err) => {
          // A signer failure BEFORE the optimistic insert leaves no timeline trace, so
          // surface it here.
          const signerDown =
            err instanceof AggregateError ||
            (err instanceof Error && /timed? ?out|abort/i.test(err.message));
          toast({
            title: "Message not sent",
            description: signerDown
              ? "Couldn't reach your signer. Check your remote signer connection and try again."
              : relayRejectionMessage(err),
            variant: "destructive",
          });
        });
      } else if (onOptimisticInsert) {
        // Fire-and-forget; signing is serialized by the signer queue (useNostrPublish).
        resetComposeState();
        onSent?.();
        noteSent();
        void (async () => {
          let signedId: string | undefined;
          try {
            await createEvent({
              kind: messageKind,
              content: finalText,
              tags,
              relay: relayUrl,
              onSigned: (event) => {
                signedId = event.id;
                onOptimisticInsert(event);
              },
            });
            if (signedId) onOptimisticSent?.(signedId);
          } catch (err) {
            // Surface the relay's OK:false reason; the message stays with a retry affordance.
            if (signedId) onOptimisticFailed?.(signedId);
            else
              toast({
                title: "Message not sent",
                description: relayRejectionMessage(err),
                variant: "destructive",
              });
          }
        })();
      } else {
        await createEvent({
          kind: messageKind,
          content: finalText,
          tags,
          relay: relayUrl,
        });
        resetComposeState();
        onSent?.();
        noteSent();
      }
    } catch (err) {
      toast({
        title: "Message not sent",
        description: relayRejectionMessage(err),
        variant: "destructive",
      });
    }
  }, [user, isSending, sendOverride, canSend, createEvent, buildMessageTags, relayUrl, resetComposeState, onSent, noteSent, toast, onOptimisticInsert, onOptimisticSent, onOptimisticFailed, messageKind]);

  const executeSlash = useCallback(async (command: SlashCommand, arg: string) => {
    // A typed command needing a missing capability (e.g. "/poll" in Concord) is sent as text.
    if (command.requires?.some((r) => !slashCapabilities.has(r))) {
      await publishMessage(`/${command.name}${arg ? ` ${arg}` : ""}`);
      return;
    }
    await executeSlashCommand(
      command,
      arg,
      { canModerate, resolvePubkey: resolveNpubArg },
      {
        send: publishMessage,
        openMention: (prefix) => {
          // Seed "@" to open mention autocomplete; `prefix` keeps a wrapping command.
          const seed = `${prefix ?? ""}@`;
          setContent(seed);
          requestAnimationFrame(() => {
            const el = textareaRef.current;
            el?.focus();
            el?.setSelectionRange(seed.length, seed.length);
          });
        },
        clearDraft: resetComposeState,
        onError: (message) =>
          toast({ title: "Command failed", description: message, variant: "destructive" }),
        onAction: async (action) => {
          if (action.kind === "openPoll") {
            setContent("");
            setMode("poll");
            textareaRef.current?.focus();
            return;
          }
          try {
            await onSlashAction?.(action);
            resetComposeState();
          } catch {
            toast({ title: "Command failed", description: "The action could not be completed.", variant: "destructive" });
          }
        },
      },
    );
  }, [canModerate, onSlashAction, resetComposeState, toast, publishMessage, slashCapabilities]);

  const runSlashFromMenu = useCallback((command: SlashCommand) => {
    const parsed = parseSlashCommand(textareaRef.current?.value ?? "");
    void executeSlash(command, parsed?.command === command ? parsed.arg : "");
  }, [executeSlash]);

  /**
   * Room: carries a `["bot", <pubkey>]` routing tag. 1:1 DM: plain content, no tag.
   */
  const sendInvocation = useCallback(async (bot: string, name: string, text: string) => {
    rememberBotCommand(bot, name);
    armedBotRef.current = undefined;
    await publishMessage(text, invocationTags(bot, { dm: botDmPeer !== undefined }));
  }, [publishMessage, rememberBotCommand, botDmPeer]);

  const runBotFromMenu = useCallback((entry: BotCommandEntry) => {
    armedBotRef.current = entry.bot;
    // Nothing to fill in, so picking it IS the send.
    if (entry.command.args.length === 0) {
      setContent("");
      void sendInvocation(entry.bot, entry.command.name, `/${entry.command.name}`);
      return;
    }
    setContent("");
    setBotCommand(entry);
  }, [sendInvocation]);

  /** Seed the draft with a command; the picker watches for that shape and opens itself. */
  const startCommand = useCallback((name: string) => {
    setPlusOpen(false);
    setBotCommand(null);
    armedBotRef.current = undefined;
    const draft = `/${name}`;
    setContent(draft);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      el?.focus();
      el?.setSelectionRange(draft.length, draft.length);
    });
  }, []);

  const openCommandMenu = useCallback(() => startCommand(""), [startCommand]);

  // Clicking a command in the timeline re-arms it here, already filtered.
  useCommandRequests(startCommand);

  const cancelBotCommand = useCallback(() => {
    setBotCommand(null);
    armedBotRef.current = undefined;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const submitBotCommand = useCallback((text: string) => {
    const entry = botCommand;
    if (!entry) return;
    setBotCommand(null);
    void sendInvocation(entry.bot, entry.command.name, text);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [botCommand, sendInvocation]);

  const handleSend = useCallback(async () => {
    // Its URL isn't in `attachments` yet; sending now would drop the file.
    if (isUploading) return;

    const text = canonicalizeLinks(content.trim());

    if (text.startsWith("/") && attachments.length === 0) {
      const parsed = parseSlashCommand(text);
      if (parsed) {
        await executeSlash(parsed.command, parsed.arg);
        return;
      }

      // A hand-typed bot command. Local commands are matched first.
      const invocation = parseInvocation(text, botEntries, armedBotRef.current);
      if (invocation) {
        // Block bad arguments (the draft would be gone for a rejected invocation).
        const error = validateInvocation(invocation.command, invocation.args);
        if (error) {
          toast({
            title: `/${invocation.command.name}`,
            description: `${error}\n${usageLine(invocation.command)}`,
            variant: "destructive",
          });
          return;
        }
        // Ambiguous between bots: send untagged rather than silencing one.
        if (invocation.ambiguous) {
          armedBotRef.current = undefined;
          await publishMessage(text);
          return;
        }
        await sendInvocation(invocation.bot, invocation.command.name, text);
        return;
      }

      // Unknown /command: fall through and send it literally.
    }

    const extraUrls = attachments
      .map((a) => a.url)
      .filter((url) => !text.includes(url));
    const finalText = [text, ...extraUrls].filter(Boolean).join("\n");
    await publishMessage(finalText);
  }, [content, attachments, isUploading, canonicalizeLinks, executeSlash, publishMessage, botEntries, sendInvocation, toast]);

  const pollFilledCount = pollOptions.filter((o) => o.label.trim()).length;
  const isPollValid = content.trim().length > 0 && pollFilledCount >= 2;
  const hasContent = content.trim().length > 0 || attachments.length > 0;

  const handlePollSubmit = useCallback(async () => {
    const finalContent = canonicalizeLinks(content.trim());
    const filledOptions = pollOptions
      .filter((o) => o.label.trim())
      .map((o) => ({ id: o.id, label: o.label.trim() }));
    if (!finalContent || filledOptions.length < 2 || !user || isSending || isUploading) return;

    // Check here so the refusal names the wait.
    const refusal = canSend?.();
    if (refusal) {
      toast({ title: "Poll not published", description: refusal, variant: "destructive" });
      return;
    }

    try {
      if (onPollSubmit) {
        // Concord seals the poll; no `relay` tag since votes ride the sealed plane.
        await onPollSubmit({ question: finalContent, options: filledOptions, pollType, durationDays: pollDuration });
      } else {
        const tags = buildMessageTags(finalContent);
        tags.push(...buildPollTags(finalContent, filledOptions, pollType, pollDuration));
        // NIP-88: votes go to `relay`-tagged relays; the group host enforces membership.
        tags.push(["relay", relayUrl]);
        await createEvent({ kind: KIND_POLL, content: finalContent, tags, relay: relayUrl });
      }
      resetComposeState();
      onSent?.();
      noteSent();
      toast({ title: "Poll published!" });
    } catch {
      toast({ title: "Error", description: "Failed to publish poll.", variant: "destructive" });
    }
  }, [content, pollOptions, user, isSending, isUploading, canSend, canonicalizeLinks, buildMessageTags, pollType, pollDuration, createEvent, relayUrl, resetComposeState, onSent, noteSent, toast, onPollSubmit]);

  /** Stop recording, upload, and send as a voice message (kind 9 + imeta). */
  const handleStopAndSendVoice = useCallback(async () => {
    if (!user) return;
    // Before `stopRecording` (which consumes the take) and before uploading.
    const refusal = canSend?.();
    if (refusal) {
      toast({ title: "Message not sent", description: refusal, variant: "destructive" });
      return;
    }
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
      let file = new File([recording.blob], `voice-message-${Date.now()}${ext}`, {
        type: recording.mimeType,
      });

      // The plaintext, kept to play the upload locally (see primeAttachment).
      const plainFile = file;
      let encryption: (ImetaEncryption & { ox: string }) | undefined;
      if (encryptAttachments) {
        const enc = await encryptFileForUpload(file);
        file = enc.file;
        encryption = { algorithm: "aes-gcm", key: enc.key, nonce: enc.nonce, ox: enc.originalHash };
      }

      const uploadTags = await uploadFile(file);
      const audioUrl = uploadTags[0][1];
      primeAttachment(audioUrl, encryption, plainFile);

      const tags = buildMessageTags(audioUrl);
      // Carry waveform + duration (and decryption params when encrypted).
      const imetaIndex = tags.findIndex((t) => t[0] === "imeta" && t.includes(`url ${audioUrl}`));
      const imetaFields = [
        `url ${audioUrl}`,
        `m ${recording.mimeType}`,
        `waveform ${recording.waveform.join(" ")}`,
        `duration ${Math.round(recording.duration)}`,
      ];
      if (encryption) {
        imetaFields.push(
          `encryption-algorithm ${encryption.algorithm}`,
          `decryption-key ${encryption.key}`,
          `decryption-nonce ${encryption.nonce}`,
          `ox ${encryption.ox}`,
        );
      }
      const imetaTag = ["imeta", ...imetaFields];
      if (imetaIndex >= 0) {
        tags[imetaIndex] = imetaTag;
      } else {
        tags.push(imetaTag);
      }

      if (sendOverride) {
        await sendOverride(audioUrl, tags);
      } else {
        await createEvent({
          kind: messageKind,
          content: audioUrl,
          tags,
          relay: relayUrl,
        });
      }

      onCancelReply?.();
      onSent?.();
      noteSent();
    } catch {
      toast({ title: "Error", description: "Failed to send voice message.", variant: "destructive" });
    } finally {
      setIsPublishingVoice(false);
    }
  }, [user, voiceRecorder, uploadFile, buildMessageTags, createEvent, relayUrl, sendOverride, canSend, encryptAttachments, onCancelReply, onSent, noteSent, toast, messageKind]);

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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ignore Enter confirming an IME composition. Documents (unless opted in)
    // and send-on-Enter off use Ctrl/Cmd+Enter to send.
    const sendKey = (isDocument && !documentEnterSends) || !enterSends
      ? e.key === "Enter" && (e.ctrlKey || e.metaKey)
      : e.key === "Enter" && !e.shiftKey;
    if (sendKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (mode === "poll") {
        handlePollSubmit();
      } else {
        handleSend();
      }
    } else if (e.key === "Escape" && mode === "poll") {
      // Poll mode's only keyboard exit.
      e.preventDefault();
      setMode("post");
    } else if (e.key === "Escape" && isDocument && onCancel && !hasContent && pendingUploads.length === 0) {
      // Only an empty in-place editor is put away with Escape.
      e.preventDefault();
      onCancel();
    } else if (e.key === "Escape" && replyTo && onCancelReply && !e.defaultPrevented && !e.nativeEvent.isComposing) {
      // Drops the reply target; an open autocomplete claims Escape first.
      e.preventDefault();
      onCancelReply();
    } else if (
      e.key === "ArrowUp" &&
      onEditLast &&
      mode === "post" &&
      !replyTo &&
      !hasContent &&
      pendingUploads.length === 0 &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.nativeEvent.isComposing
    ) {
      if (onEditLast()) e.preventDefault();
    }
  };

  const onPickerChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) handleFiles(Array.from(files));
    e.target.value = "";
    // The native picker steals focus; restore it so Enter sends.
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [handleFiles]);

  const cancelPending = useCallback((id: string) => {
    pendingAborts.current.get(id)?.abort();
  }, []);

  const trayItems = useMemo<TrayItem[]>(() => {
    const done = attachments.map((att) => ({
      seq: attachmentSeq.current.get(att.url) ?? -1,
      item: {
        kind: "attachment" as const,
        url: att.url,
        mime: att.mime,
        label: att.label,
        icon: att.icon,
        isImage: att.isImage,
        isVideo: att.isVideo,
        isAudio: att.isAudio,
        isWebxdc: att.isWebxdc,
        encryption: att.encryption,
        alt: att.alt,
        spoiler: att.spoiler,
      },
    }));
    const pending = pendingUploads.map((p) => ({
      seq: p.seq,
      item: {
        kind: "pending" as const,
        id: p.id,
        label: p.name,
        previewUrl: p.previewUrl,
        phase: p.phase,
        progress: p.progress,
      },
    }));
    return [...done, ...pending].sort((a, b) => a.seq - b.seq).map((x) => x.item);
  }, [attachments, pendingUploads]);

  const pollAvailable = !((Boolean(sendOverride) && !onPollSubmit) || !pollsEnabled);
  const togglePoll = useCallback(() => {
    setMode((m) => (m === "poll" ? "post" : "poll"));
    textareaRef.current?.focus();
  }, []);
  const openGames = useCallback(() => {
    setPickerTab("games");
    setPickerOpen(true);
  }, []);

  const extraActions = useMemo<AttachAction[]>(() => {
    const list: AttachAction[] = [];
    if (pollAvailable) list.push({ id: "poll", label: mode === "poll" ? "Remove poll" : "Poll", icon: BarChart3, onSelect: togglePoll, active: mode === "poll" });
    list.push({ id: "game", label: "Add game", icon: Blocks, onSelect: openGames });
    if (appScope) list.push({ id: "watch", label: "Watch together", icon: MonitorPlay, onSelect: () => launchApp(appScope, { type: "youtube" }) });
    // Hidden mid-draft: the command menu keys off a draft that is just "/".
    if (botEntries.length > 0) list.push({ id: "commands", label: "Commands", icon: SquareSlash, onSelect: openCommandMenu, disabled: hasContent });
    return list;
  }, [pollAvailable, mode, togglePoll, openGames, appScope, launchApp, botEntries.length, openCommandMenu, hasContent]);

  const menuActions = useMemo<AttachAction[]>(() => [
    { id: "file", label: "Upload a file", icon: Paperclip, onSelect: () => fileInputRef.current?.click() },
    ...extraActions,
  ], [extraActions]);

  const sheetActions = useMemo<AttachAction[]>(() => [
    { id: "photos", label: hasMediaGallery() ? "Gallery" : "Photos", icon: ImageIcon, onSelect: () => mediaInputRef.current?.click() },
    { id: "camera", label: "Camera", icon: Camera, onSelect: () => cameraInputRef.current?.click() },
    { id: "file", label: "File", icon: Paperclip, onSelect: () => fileInputRef.current?.click() },
    // These sit behind the sheet's "Apps" tile, keeping the row to one line.
    ...extraActions.filter((a) => a.id !== "game" && a.id !== "watch" && a.id !== "commands"),
  ], [extraActions]);

  const sheetApps = useMemo<AttachAction[]>(
    () => extraActions.filter((a) => a.id === "watch" || a.id === "commands"),
    [extraActions],
  );
  const sheetGamePicker = useMemo(
    () => (
      <WebxdcGamePicker
        relays={conversationRelays}
        onSelect={(app) => {
          setPlusOpen(false);
          void registerGame(app);
        }}
      />
    ),
    [conversationRelays, registerGame],
  );

  const plusButtonClass = "p-2 shrink-0 rounded-full transition-colors flex items-center justify-center size-9 touch:size-11";

  const charCount = content.length;
  const placeholderText = mode === "poll" ? "Ask a question…" : (placeholder ?? "Message this channel…");

  return (
    <div
      ref={(node) => { composerBoundsRef.current = node; }}
      className="relative shrink-0 pb-[var(--safe-area-pad-bottom,0px)] sidebar:pb-[var(--safe-area-pad-bottom-tight,0.25rem)]"
      onFocusCapture={claimPasteOwnership}
      onPointerDownCapture={claimPasteOwnership}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="absolute inset-0 z-30 m-1 flex items-center justify-center clip-corner-lg border-2 border-dashed border-primary/60 bg-primary/10 backdrop-blur-sm pointer-events-none animate-in fade-in-0 duration-150">
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            <Paperclip className="size-4" />
            Drop files to upload
          </div>
        </div>
      )}

      {replyTo && (
        <div className="px-3 pt-2">
          <ReplyBanner event={replyTo} onCancel={onCancelReply} />
        </div>
      )}

      {visibleEmbeds.length > 0 && (
        <div className="px-3 pt-2 space-y-1 max-h-40 overflow-y-auto animate-in slide-in-from-top-2 fade-in-0 duration-200">
          {visibleEmbeds.map((embed) => (
            <QuoteBanner
              key={embed.value}
              embed={embed}
              onRemove={() => setRemovedEmbeds((prev) => new Set(prev).add(embed.value))}
            />
          ))}
        </div>
      )}

      <AttachmentTray
        items={trayItems}
        isTouch={isTouch}
        onPreview={setLightboxUrl}
        onRemove={removeAttachment}
        onCancel={cancelPending}
        onUpdate={updateAttachment}
      />

      <div className="p-2">
        {voiceRecorder.isRecording || isPublishingVoice ? (
          <div className="flex items-center gap-3 rounded-xl bg-destructive/5 border border-destructive/20 px-3 py-2.5">
            <div className="flex items-center gap-2 min-w-0">
              <div className="size-2.5 rounded-full bg-destructive animate-pulse shrink-0" />
              <span className="text-sm font-medium tabular-nums text-destructive">
                {formatTime(voiceRecorder.recordingDuration)}
              </span>
            </div>

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
                  className="p-2 touch:p-3.5 rounded-full text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-40"
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
            {/* `capture` goes straight to the camera where the WebView supports it. */}
            <input ref={fileInputRef} type="file" accept="*/*" multiple className="hidden" onChange={onPickerChange} />
            <input ref={mediaInputRef} type="file" accept="image/*,video/*" multiple className="hidden" onChange={onPickerChange} />
            <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onPickerChange} />

            {botCommand ? (
              <BotCommandComposer
                entry={botCommand}
                memberPubkeys={memberPubkeys ?? []}
                profiles={botProfiles}
                recentAuthors={recentAuthorsResolved}
                onSubmit={submitBotCommand}
                onCancel={cancelBotCommand}
              />
            ) : (
            /* A document wraps: the textarea takes the first line, controls fall onto a toolbar row. */
            <div
              className={cn(
                "clip-corner-lg bg-secondary/60 px-1.5 py-1.5",
                isDocument ? "flex flex-wrap items-center gap-0.5 touch:gap-1.5" : "flex items-end gap-0.5 touch:gap-1.5",
              )}
            >
              {/* Pointer: a double-click on "+" skips the menu and opens the file picker. */}
              {isTouch ? (
                <>
                  <button
                    type="button"
                    aria-label="Attach"
                    aria-haspopup="dialog"
                    onClick={() => setPlusOpen(true)}
                    className={cn(plusButtonClass, plusOpen || mode === "poll"
                      ? "text-primary bg-primary/10"
                      : "text-muted-foreground hover:text-foreground hover:bg-secondary")}
                  >
                    <Plus className={cn("size-5 transition-transform", plusOpen && "rotate-45")} />
                  </button>
                  <AttachSheet
                    open={plusOpen}
                    onOpenChange={setPlusOpen}
                    actions={sheetActions}
                    apps={sheetApps}
                    gamePicker={sheetGamePicker}
                    onPickGalleryItems={handleGalleryItems}
                  />
                </>
              ) : (
                <Popover open={plusOpen} onOpenChange={setPlusOpen}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-label="More options"
                      onDoubleClick={() => {
                        setPlusOpen(false);
                        fileInputRef.current?.click();
                      }}
                      className={cn(plusButtonClass, plusOpen || mode === "poll"
                        ? "text-primary bg-primary/10"
                        : "text-muted-foreground hover:text-foreground hover:bg-secondary")}
                    >
                      <Plus className={cn("size-5 transition-transform", plusOpen && "rotate-45")} />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    side="top"
                    align="start"
                    sideOffset={8}
                    // Items like Poll/Commands focus the textarea themselves; don't clobber it.
                    onCloseAutoFocus={(e) => e.preventDefault()}
                    className="w-60 p-1.5 rounded-xl border-border shadow-lg"
                  >
                    <div className="flex flex-col gap-0.5">
                      {menuActions.map((action, i) => (
                        <button
                          key={action.id}
                          type="button"
                          disabled={action.disabled}
                          onClick={() => {
                            setPlusOpen(false);
                            action.onSelect();
                          }}
                          className={cn(
                            "group/item flex items-center gap-3 w-full px-2 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
                            action.active ? "text-primary bg-primary/10" : "text-foreground/90 hover:bg-secondary/70 enabled:hover:text-foreground",
                            i === 1 && "mt-1 relative before:absolute before:-top-0.5 before:inset-x-2 before:h-px before:bg-border/60",
                          )}
                        >
                          <span
                            className={cn(
                              "flex size-8 shrink-0 items-center justify-center rounded-lg",
                              action.active ? "bg-primary/15" : "bg-secondary/80 text-muted-foreground group-hover/item:text-foreground",
                            )}
                          >
                            <action.icon className="size-[18px]" />
                          </span>
                          {action.label}
                        </button>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              )}

              <div className={cn("relative flex-1 min-w-0", isDocument && "order-first basis-full")}>
                {/* Overlay, not the `placeholder` attribute: a wrapped native placeholder
                    inflates scrollHeight and the empty composer to two lines. */}
                {!content && (
                  <div
                    aria-hidden
                    dir="auto"
                    className={cn(
                      "pointer-events-none select-none absolute inset-x-0 top-0 truncate px-1.5 py-2 touch:py-3 text-muted-foreground",
                      isDocument ? "text-[15px] leading-relaxed" : "leading-5 text-base md:text-sm",
                    )}
                  >
                    {placeholderText}
                  </div>
                )}
                <textarea
                  ref={textareaRef}
                  dir="auto"
                  value={content}
                  onChange={(e) => {
                    const { value, selectionStart, selectionEnd } = e.target;
                    // Only a single `:` typed at a collapsed caret closes a shortcode.
                    const closedShortcode =
                      selectionStart === selectionEnd &&
                      value.length === content.length + 1 &&
                      value[selectionStart - 1] === ":"
                        ? completedShortcodeAt(value, selectionStart, customShortcodes)
                        : null;
                    if (closedShortcode) insertAtCursor(closedShortcode);
                    else setContent(value);
                    if (value) onTyping?.();
                  }}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  aria-label={placeholderText}
                  rows={isDocument ? 5 : 1}
                  maxLength={MAX_CHARS}
                  className={cn(
                    "block w-full resize-none bg-transparent border-0 outline-none px-1.5 py-2 touch:py-3 disabled:opacity-50 overflow-y-auto align-middle",
                    isDocument
                      ? "text-[15px] leading-relaxed"
                      : "leading-5 text-base md:text-sm max-h-40",
                  )}
                />
                {mentionsEnabled && (
                  <MentionAutocomplete
                    textareaRef={textareaRef}
                    content={content}
                    onInsertMention={insertAtCursor}
                    restrictToPubkeys={memberPubkeys}
                    allowEveryone={canMentionEveryone}
                  />
                )}
                <SlashCommandAutocomplete
                  textareaRef={textareaRef}
                  content={content}
                  canModerate={canModerate}
                  capabilities={slashCapabilities}
                  onInsertCommand={insertAtCursor}
                  onRunCommand={runSlashFromMenu}
                  botEntries={botEntries}
                  botCount={botPubkeys.length}
                  botsLoading={botsLoading}
                  botRecents={botRecents}
                  onRunBotCommand={runBotFromMenu}
                />
                <EmojiShortcodeAutocomplete
                  textareaRef={textareaRef}
                  content={content}
                  onInsertEmoji={insertAtCursor}
                />
              </div>

              <div ref={pickerToggleGroupRef} className="flex shrink-0 items-center gap-0.5 touch:gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => togglePickerTab("emoji")}
                      aria-label="Emoji / Stickers"
                      className={cn(
                        "p-2 shrink-0 rounded-full transition-colors flex items-center justify-center size-9 touch:size-11",
                        pickerOpen && pickerTab !== "gif"
                          ? "text-primary bg-primary/10"
                          : "text-muted-foreground hover:text-foreground hover:bg-secondary",
                      )}
                    >
                      <Smile className="size-5" />
                    </button>
                  </TooltipTrigger>
                  {(!pickerOpen || pickerTab === "gif") && <TooltipContent>Emoji</TooltipContent>}
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => togglePickerTab("gif")}
                      aria-label="GIFs"
                      className={cn(
                        "p-2 shrink-0 rounded-full transition-colors flex items-center justify-center size-9 touch:size-11",
                        pickerOpen && pickerTab === "gif"
                          ? "text-primary bg-primary/10"
                          : "text-muted-foreground hover:text-foreground hover:bg-secondary",
                      )}
                    >
                      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                        <rect x="1.5" y="2.5" width="17" height="15" rx="3" stroke="currentColor" strokeWidth="1.5" />
                        <text x="10" y="10.5" textAnchor="middle" dominantBaseline="central" fontSize="7" fontWeight="700" fontFamily="system-ui,sans-serif" fill="currentColor" letterSpacing="0.4">GIF</text>
                      </svg>
                    </button>
                  </TooltipTrigger>
                  {(!pickerOpen || pickerTab !== "gif") && <TooltipContent>GIFs</TooltipContent>}
                </Tooltip>
              </div>

              {/* Mic when empty, send otherwise. Documents have no mic. */}
              {isDocument ? (
                <>
                  {onCancel && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={onCancel}
                      className="ml-auto h-9 px-3 text-muted-foreground hover:text-foreground touch:h-11"
                    >
                      Cancel
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={mode === "poll" ? handlePollSubmit : handleSend}
                    disabled={isUploading || (mode === "poll" ? !isPollValid || isSending : !hasContent)}
                    className={cn("clip-corner-lg h-9 px-4 font-semibold touch:h-11", !onCancel && "ml-auto")}
                  >
                    {isUploading || (mode === "poll" && isSending) ? <Loader2 className="size-4 animate-spin" /> : null}
                    {mode === "poll" ? "Publish poll" : submitLabel}
                  </Button>
                </>
              ) : mode === "post" && !hasContent && !isUploading && voiceRecorder.isSupported ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleStartRecording}
                      aria-label="Voice message"
                      className="p-2 shrink-0 rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors flex items-center justify-center size-9 touch:size-11"
                    >
                      <Mic className="size-5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Voice message</TooltipContent>
                </Tooltip>
              ) : (
                <button
                  type="button"
                  // Keep the textarea focused: on iOS a blur dismisses the keyboard, reflows,
                  // and the click misses. Must be pointerdown (iOS synthesizes mouse events late).
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={mode === "poll" ? handlePollSubmit : handleSend}
                  disabled={isUploading || (mode === "poll" ? !isPollValid || isSending : !hasContent)}
                  aria-label={isUploading ? "Uploading attachment" : mode === "poll" ? "Publish poll" : "Send message"}
                  className="p-2 shrink-0 clip-corner-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40 disabled:bg-transparent disabled:text-muted-foreground flex items-center justify-center size-9 touch:size-11"
                >
                  {isUploading || (mode === "poll" && isSending)
                    ? <Loader2 className="size-4 animate-spin" />
                    : <ArrowUpRight className="size-5" strokeWidth={2.5} />}
                </button>
              )}
            </div>
            )}

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

            {pollMounted && (
              <div
                className={cn(
                  "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
                  pollVisible ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
                )}
              >
                <div className="overflow-hidden min-h-0">
                <div className="space-y-2 pt-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">Poll</span>
                    <button
                      type="button"
                      aria-label="Close poll"
                      onClick={() => setMode("post")}
                      className="p-1 touch:p-2.5 rounded-full text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
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
                        className="p-1 touch:p-2.5 rounded-full text-muted-foreground hover:text-destructive transition-colors disabled:opacity-20"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  ))}

                  {pollOptions.length < 8 && (
                    <button
                      type="button"
                      onClick={() => setPollOptions((prev) => [...prev, { id: pollOptionId(), label: "" }])}
                      className="flex items-center gap-1.5 text-xs touch:text-sm text-primary hover:text-primary/80 transition-colors pt-0.5 touch:py-2"
                    >
                      <Plus className="size-3" />
                      Add option
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  {(["singlechoice", "multiplechoice"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setPollType(t)}
                      className={cn(
                        "text-xs px-2.5 py-1 touch:px-3.5 touch:py-2 rounded-full border transition-colors",
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
                        "text-xs px-2.5 py-1 touch:px-3.5 touch:py-2 rounded-full border transition-colors",
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
          {pickerTab !== "gif" && pickerTab !== "games" && customEmojis.length > 0 && (
            <div className="flex gap-1 px-3 pt-2">
              <button
                type="button"
                onClick={() => setPickerTab("emoji")}
                className={cn(
                  "flex items-center justify-center gap-1.5 px-4 py-1.5 touch:py-2.5 rounded-full text-sm font-medium transition-colors",
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
                onClick={() => setPickerTab("stickers")}
                className={cn(
                  "flex items-center justify-center gap-1.5 px-4 py-1.5 touch:py-2.5 rounded-full text-sm font-medium transition-colors",
                  pickerTab === "stickers"
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted",
                )}
              >
                <Sticker className="size-3.5" />
                Stickers
              </button>
              <BrowseEmojiPacksButton className="ml-auto" onBrowse={() => setPickerOpen(false)} />
            </div>
          )}

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
                onBrowsePacks={() => setPickerOpen(false)}
                packsLinkInHost
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
                requestAnimationFrame(() => textareaRef.current?.focus());
              }}
            />
          ) : pickerTab === "games" ? (
            <WebxdcGamePicker onSelect={registerGame} relays={conversationRelays} />
          ) : (
            <GifPicker
              onSelect={(gif) => {
                registerAttachment(gif.url, "image/gif", `${gif.width}x${gif.height}`);
                setPickerOpen(false);
                // Restore focus so Enter sends the attached GIF.
                requestAnimationFrame(() => textareaRef.current?.focus());
              }}
            />
          )}
          </div>
        </div>
      )}

      {lightboxIndex !== -1 && (
        <Lightbox
          media={galleryAttachments}
          currentIndex={lightboxIndex}
          onClose={closeLightbox}
          onNext={lightboxNext}
          onPrev={lightboxPrev}
        />
      )}
    </div>
  );
}

function ReplyBanner({ event, onCancel }: { event: NostrRumor; onCancel?: () => void }) {
  const author = useAuthor(event.pubkey);
  const metadata = author.data?.metadata;
  const displayName = useScopedDisplayName(event.pubkey, metadata);

  return (
    <div className="flex items-center gap-2 rounded-md bg-secondary/50 py-2 pl-2.5 pr-1 text-sm animate-in slide-in-from-top-2 fade-in-0 duration-200">
      <Reply className="size-4 text-muted-foreground shrink-0" />
      <span className="min-w-0 flex-1 flex items-center gap-1.5 text-muted-foreground">
        <span className="shrink-0">Replying to</span>
        <Avatar shape={getAvatarShape(metadata)} className="size-5 shrink-0">
          <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt="" />
          <AvatarFallback className="bg-primary/20 text-primary text-[9px]">
            {displayName[0]?.toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <span className="font-semibold text-primary truncate min-w-0">
          <DisplayName pubkey={event.pubkey} name={displayName} />
        </span>
      </span>
      <button
        type="button"
        aria-label="Cancel reply"
        onClick={onCancel}
        className="-mr-0.5 flex size-8 touch:size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors shrink-0"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

/** Single-line "Quoting <Name>: <snippet>" bar for a quote detected in the draft. */
function QuoteBanner({ embed, onRemove }: { embed: DetectedEmbed; onRemove: () => void }) {
  const isAddr = embed.type === "naddr";
  const noteQuery = useEvent(
    isAddr ? undefined : embed.eventId,
    embed.relay ? [embed.relay] : undefined,
    embed.author,
  );
  const addrQuery = useAddrEvent(isAddr ? embed.addr : undefined);
  const event = isAddr ? addrQuery.data : noteQuery.data;
  const isLoading = isAddr ? addrQuery.isLoading : noteQuery.isLoading;

  return (
    <div className="flex items-center gap-2 rounded-md bg-secondary/50 py-2 pl-2.5 pr-1 text-sm animate-in slide-in-from-top-2 fade-in-0 duration-200">
      <Quote className="size-4 text-muted-foreground shrink-0" />
      {event ? (
        <QuoteBannerBody event={event} />
      ) : (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {isLoading ? "Loading quoted post…" : "Quoted post unavailable"}
        </span>
      )}
      <button
        type="button"
        aria-label="Remove quote"
        onClick={onRemove}
        className="-mr-0.5 flex size-8 touch:size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors shrink-0"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

/** Split out so the author hooks only run once the quoted event exists. */
function QuoteBannerBody({ event }: { event: NostrRumor }) {
  const author = useAuthor(event.pubkey);
  const metadata = author.data?.metadata;
  const displayName = useScopedDisplayName(event.pubkey, metadata);
  const title = event.tags.find(([name]) => name === "title")?.[1];

  return (
    <span className="min-w-0 flex-1 flex items-center gap-1.5 text-muted-foreground">
      <span className="shrink-0">Quoting</span>
      <Avatar shape={getAvatarShape(metadata)} className="size-5 shrink-0">
        <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt="" />
        <AvatarFallback className="bg-primary/20 text-primary text-[9px]">
          {displayName[0]?.toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="font-semibold text-primary shrink-0 truncate max-w-[45%]">
        <DisplayName pubkey={event.pubkey} name={displayName} />
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground/70">
        {title ? title : <ReplyPreview content={event.content} tags={event.tags} />}
      </span>
    </span>
  );
}
