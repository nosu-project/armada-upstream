import { CircleDot, Loader2, Paperclip, Plus, X } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useGitAttachmentUploads } from "@/hooks/useGitAttachmentUploads";
import { toast } from "@/hooks/useToast";
import { MAX_GIT_LABELS, MAX_GIT_LABEL_LENGTH, normalizeGitLabels } from "@/lib/gitActivity";
import { cn } from "@/lib/utils";

import { labelSuggestions, type ProjectRepo, type ProjectWorkItem } from "@/components/projects/projectData";

/** Open a new issue against one of the project's repositories. */
export function NewIssueDialog({ repos, items, onCreate }: {
  repos: ProjectRepo[];
  /** Existing work items, mined for the repository's own label vocabulary. */
  items: ProjectWorkItem[];
  onCreate: (repoCoord: string, subject: string, body: string, media?: readonly string[][], labels?: readonly string[]) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [repoCoord, setRepoCoord] = useState<string | undefined>(undefined);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [labelDraft, setLabelDraft] = useState("");
  const [addingLabel, setAddingLabel] = useState(false);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const appendUrl = useCallback((url: string) => {
    setBody((prev) => (prev.trim() ? `${prev.trimEnd()}\n${url}\n` : `${url}\n`));
  }, []);
  const { attach, isUploading, mediaFor } = useGitAttachmentUploads(appendUrl);

  const selected = repoCoord ?? repos[0]?.coord;
  // Suggestions follow the chosen repository: label vocabulary is per project.
  const suggestions = useMemo(() => labelSuggestions(items, selected), [items, selected]);
  const toggleLabel = useCallback((label: string) => {
    setLabels((current) => current.includes(label)
      ? current.filter((value) => value !== label)
      : normalizeGitLabels([...current, label]));
  }, []);
  const commitLabelDraft = useCallback(() => {
    const [added] = normalizeGitLabels([labelDraft]);
    if (added) setLabels((current) => (current.includes(added) ? current : normalizeGitLabels([...current, added])));
    setLabelDraft("");
    setAddingLabel(false);
  }, [labelDraft]);
  const cancelLabelDraft = useCallback(() => {
    setLabelDraft("");
    setAddingLabel(false);
  }, []);
  if (repos.length === 0) return null;

  const submit = () => {
    if (!selected || !subject.trim() || sending || isUploading) return;
    setSending(true);
    const trimmedBody = body.trim();
    // A label typed but not yet committed still counts as intent.
    const finalLabels = normalizeGitLabels([...labels, labelDraft]);
    onCreate(selected, subject.trim(), trimmedBody, mediaFor(trimmedBody), finalLabels)
      .then(() => {
        toast({ title: "Issue opened" });
        setOpen(false);
        setRepoCoord(undefined);
        setSubject("");
        setBody("");
        setLabels([]);
        setLabelDraft("");
        setAddingLabel(false);
      })
      .catch((error) => toast({ title: "Couldn't open issue", description: error instanceof Error ? error.message : undefined, variant: "destructive" }))
      .finally(() => setSending(false));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-8 shrink-0 clip-corner-lg">
          <Plus className="mr-1.5 size-3.5" />
          New issue
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-md"
        onEscapeKeyDown={(event) => {
          // While the label field is open, Escape dismisses it, not the dialog.
          if (!addingLabel) return;
          event.preventDefault();
          cancelLabelDraft();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CircleDot className="size-4 text-orange-500" />
            New issue
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {repos.length > 1 && (
            <Select value={selected} onValueChange={setRepoCoord}>
              <SelectTrigger aria-label="Repository">
                <SelectValue placeholder="Repository" />
              </SelectTrigger>
              <SelectContent>
                {repos.map((repo) => (
                  <SelectItem key={repo.coord} value={repo.coord}>{repo.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Title"
            autoFocus
          />
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Describe the issue (optional)"
            rows={5}
            className="resize-none text-sm"
          />

          {/* Labels. Chips wrap and the block scrolls, so a long vocabulary
              never widens the dialog or pushes the actions off-screen. */}
          <div className="min-w-0 space-y-1.5">
            <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
              {suggestions.map((label) => {
                const active = labels.includes(label);
                return (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={active}
                    disabled={sending || (!active && labels.length >= MAX_GIT_LABELS)}
                    onClick={() => toggleLabel(label)}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px] transition-colors disabled:opacity-40",
                      active
                        ? "border-primary/60 bg-primary/15 text-foreground"
                        : "border-border/60 text-muted-foreground hover:border-primary/40 hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
              {/* Labels added by hand that aren't in the suggestion list. */}
              {labels.filter((label) => !suggestions.includes(label)).map((label) => (
                <button
                  key={label}
                  type="button"
                  aria-pressed
                  disabled={sending}
                  onClick={() => toggleLabel(label)}
                  className="flex items-center gap-1 rounded-full border border-primary/60 bg-primary/15 px-2 py-0.5 text-[11px] text-foreground"
                >
                  {label}
                  <X className="size-2.5" />
                </button>
              ))}

              {/* Typing a new label is occasional, so it borrows a chip's
                  space only while in use rather than holding a field open. */}
              {addingLabel ? (
                <input
                  autoFocus
                  value={labelDraft}
                  size={Math.max(labelDraft.length + 1, 10)}
                  maxLength={MAX_GIT_LABEL_LENGTH}
                  aria-label="New label"
                  placeholder="new label"
                  disabled={sending}
                  onChange={(e) => setLabelDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // Escape is handled by the dialog's own onEscapeKeyDown:
                    // Radix listens for it at the document, above this field.
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      if (labelDraft.trim()) commitLabelDraft();
                      else cancelLabelDraft();
                      return;
                    }
                    // Erasing past the start of an empty field dismisses it.
                    if ((e.key === "Backspace" || e.key === "Delete") && !labelDraft) {
                      e.preventDefault();
                      cancelLabelDraft();
                    }
                  }}
                  onBlur={commitLabelDraft}
                  className="min-w-0 rounded-full border border-primary/60 bg-transparent px-2 py-0.5 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:ring-1 focus-visible:ring-ring"
                />
              ) : labels.length < MAX_GIT_LABELS && (
                <button
                  type="button"
                  aria-label="Add a label"
                  disabled={sending}
                  onClick={() => setAddingLabel(true)}
                  className="flex items-center rounded-full border border-dashed border-border/70 px-2 py-0.5 text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:opacity-40"
                >
                  <Plus className="size-3" />
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center justify-between gap-1.5">
            <p className="min-w-0 truncate text-[10px] text-muted-foreground">Public: issues are visible outside this community.</p>
            <div className="flex shrink-0 items-center gap-1.5">
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                void attach(e.target.files);
                e.target.value = "";
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground"
              aria-label="Attach files"
              disabled={isUploading}
              onClick={() => fileInput.current?.click()}
            >
              {isUploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
            </Button>
            <Button size="sm" disabled={sending || isUploading || !subject.trim()} onClick={submit}>
              {sending ? <Loader2 className="size-4 animate-spin" /> : "Open issue"}
            </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
