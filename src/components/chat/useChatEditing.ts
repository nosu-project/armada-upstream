import { useCallback, useRef, useState } from "react";

import { lastEditableOwnMessage, type ChatMsg } from "@/components/chat/transport";
import { toast } from "@/hooks/useToast";

/**
 * Inline message editing shared by every chat surface, including `editLast`
 * (↑-to-edit). Inputs are read through a ref so callbacks stay render-stable.
 * No reset here: each caller decides via `setEditingId` (DMs clear on switch,
 * Concord doesn't).
 */
export function useChatEditing(input: {
  edit: (original: ChatMsg, content: string) => Promise<unknown> | void;
  messages: readonly ChatMsg[];
  /** Whether an id is a still-pending/failed optimistic send (not editable). */
  isPending?: (id: string) => boolean;
  self: string | undefined;
}) {
  const latest = useRef(input);
  latest.current = input;
  const [editingId, setEditingId] = useState<string | undefined>(undefined);

  const startEditing = useCallback((event: ChatMsg) => setEditingId(event.id), []);
  const cancelEditing = useCallback(() => setEditingId(undefined), []);

  const handleEditSubmit = useCallback(async (original: ChatMsg, content: string) => {
    setEditingId(undefined);
    const trimmed = content.trim();
    if (!trimmed || trimmed === original.content.trim()) return;
    try {
      await latest.current.edit(original, trimmed);
    } catch {
      toast({ title: "Edit failed", description: "Could not publish the edit.", variant: "destructive" });
    }
  }, []);

  const editLast = useCallback(() => {
    const { messages, self, isPending } = latest.current;
    const target = lastEditableOwnMessage(messages, self, isPending);
    if (!target) return false;
    setEditingId(target.id);
    return true;
  }, []);

  return { editingId, setEditingId, startEditing, cancelEditing, handleEditSubmit, editLast };
}
