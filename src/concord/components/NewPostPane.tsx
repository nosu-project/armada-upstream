import { ArrowLeft } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { ChatComposer } from "@/components/chat/ChatComposer";
import { Button } from "@/components/ui/button";
import { ComposerBoundsProvider } from "@/contexts/ComposerBoundsContext";
import { SUBJECT_MAX_BYTES, subjectBytes } from "@/concord/lib/forum";
import { cn } from "@/lib/utils";

/** Write a forum post (CORD-03 §3) in-pane: ONE kind-9 message with a `subject` tag. */
export function NewPostPane({
  channelName,
  groupId,
  mentionPubkeys,
  canMentionEveryone,
  conversationRelays,
  canSend,
  disappearingTimer,
  onSubmit,
  onCancel,
  className,
}: {
  channelName: string;
  groupId: string;
  mentionPubkeys?: string[];
  canMentionEveryone?: boolean;
  conversationRelays?: string[];
  canSend?: () => string | null;
  /** See ChatComposer's. */
  disappearingTimer?: () => Promise<number>;
  onSubmit: (title: string, content: string, tags: string[][]) => Promise<void>;
  onCancel: () => void;
  className?: string;
}) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const composerBoundsRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const bytes = subjectBytes(title);
  const over = bytes > SUBJECT_MAX_BYTES;
  const remaining = SUBJECT_MAX_BYTES - bytes;

  // Block send on a missing title, or the feed would never list it.
  const gate = useCallback((): string | null => {
    if (!title.trim()) return "Give your post a title first.";
    if (over) return `Titles are limited to ${SUBJECT_MAX_BYTES} bytes.`;
    return canSend?.() ?? null;
  }, [title, over, canSend]);

  const submit = useCallback(
    async (content: string, tags: string[][]) => {
      setError(null);
      try {
        // The handler's `subjectTags` is the single canonical fold/validate step.
        await onSubmit(title, content, tags);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't publish the post.");
        throw e; // the composer keeps the draft
      }
    },
    [title, onSubmit],
  );

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-stable">
        <div className="mx-auto w-full max-w-2xl px-3 pb-6 pt-3 sm:px-4">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 mb-2 gap-1.5 text-muted-foreground hover:text-foreground touch:h-11"
            onClick={onCancel}
          >
            <ArrowLeft className="size-4" />
            All posts
          </Button>

          <p className="mb-1 text-xs font-medium text-muted-foreground">New post in #{channelName}</p>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Title"
            aria-label="Post title"
            aria-invalid={over || undefined}
            autoFocus
            className={cn(
              "w-full bg-transparent text-2xl font-semibold leading-tight text-foreground outline-none placeholder:text-muted-foreground/50",
              over && "text-destructive",
            )}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                bodyRef.current?.querySelector("textarea")?.focus();
              }
            }}
          />
          {(over || remaining < 40) && (
            <p className={cn("mt-1 text-xs tabular-nums text-muted-foreground", over && "text-destructive")}>
              {remaining} left
            </p>
          )}

          <div ref={bodyRef} className="mt-4">
            <ComposerBoundsProvider value={composerBoundsRef}>
              <ChatComposer
                relayUrl="dm"
                groupId={groupId}
                messages={[]}
                layout="document"
                submitLabel="Post"
                mentionPubkeys={mentionPubkeys}
                canMentionEveryone={canMentionEveryone}
                conversationRelays={conversationRelays}
                placeholder="Write your post"
                draftScope={`post:${groupId}`}
                encryptAttachments
                disappearingTimer={disappearingTimer}
                pollsEnabled={false}
                canSend={gate}
                sendOverride={submit}
              />
            </ComposerBoundsProvider>
          </div>
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </div>
      </div>
    </div>
  );
}
