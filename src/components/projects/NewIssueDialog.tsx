import { CircleDot, Loader2, Paperclip, Plus } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useGitAttachmentUploads } from "@/hooks/useGitAttachmentUploads";
import { toast } from "@/hooks/useToast";

import type { ProjectRepo } from "@/components/projects/projectData";

/** Open a new issue against one of the project's repositories. */
export function NewIssueDialog({ repos, onCreate }: {
  repos: ProjectRepo[];
  onCreate: (repoCoord: string, subject: string, body: string, media?: readonly string[][]) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [repoCoord, setRepoCoord] = useState<string | undefined>(undefined);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const appendUrl = useCallback((url: string) => {
    setBody((prev) => (prev.trim() ? `${prev.trimEnd()}\n${url}\n` : `${url}\n`));
  }, []);
  const { attach, isUploading, mediaFor } = useGitAttachmentUploads(appendUrl);

  const selected = repoCoord ?? repos[0]?.coord;
  if (repos.length === 0) return null;

  const submit = () => {
    if (!selected || !subject.trim() || sending || isUploading) return;
    setSending(true);
    const trimmedBody = body.trim();
    onCreate(selected, subject.trim(), trimmedBody, mediaFor(trimmedBody))
      .then(() => {
        toast({ title: "Issue opened" });
        setOpen(false);
        setSubject("");
        setBody("");
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
      <DialogContent className="sm:max-w-md">
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
          <div className="flex items-center justify-end gap-1.5">
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
      </DialogContent>
    </Dialog>
  );
}
