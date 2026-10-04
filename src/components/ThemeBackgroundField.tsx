import { Image as ImageIcon, Loader2, Trash2, Upload } from "lucide-react";
import { useRef } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMediaSrc } from "@/hooks/useMediaPolicy";
import { useUploadFile } from "@/hooks/useUploadFile";
import { toast } from "@/hooks/useToast";

import type { ThemeBackground } from "@/themes";

/** Upload, replace, fit and remove a theme's background image. */
export function ThemeBackgroundField({
  value,
  onChange,
  onUploadingChange,
}: {
  value: ThemeBackground | undefined;
  onChange: (background: ThemeBackground | undefined) => void;
  /** Lets the form hold its save button while an upload is in flight. */
  onUploadingChange?: (uploading: boolean) => void;
}) {
  const { mutateAsync: uploadFile, isPending: uploading } = useUploadFile();
  const fileRef = useRef<HTMLInputElement>(null);
  const thumbSrc = useMediaSrc(value?.url);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    onUploadingChange?.(true);
    try {
      const tags = await uploadFile(file);
      const url = tags[0][1];
      const mimeType = tags.find(([n]) => n === "m")?.[1];
      const dimensions = tags.find(([n]) => n === "dim")?.[1];
      onChange({ url, mode: value?.mode ?? "cover", mimeType, dimensions });
    } catch (e) {
      toast({
        title: "Couldn't upload background",
        description: e instanceof Error ? e.message : "Upload failed.",
        variant: "destructive",
      });
    } finally {
      onUploadingChange?.(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Background image
      </Label>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <div className="flex items-center gap-2">
        {value?.url && thumbSrc ? (
          <div
            className="size-11 shrink-0 clip-corner-lg bg-cover bg-center bg-secondary"
            style={{ backgroundImage: `url("${thumbSrc.replace(/["\\\n\r]/g, (c) => encodeURIComponent(c))}")` }}
          />
        ) : (
          <div className="flex size-11 shrink-0 items-center justify-center clip-corner-lg bg-secondary text-muted-foreground">
            <ImageIcon className="size-5" />
          </div>
        )}
        <Button
          variant="secondary"
          size="sm"
          className="clip-corner-lg"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          {value?.url ? "Replace" : "Upload"}
        </Button>
        {value?.url && (
          <>
            <Select
              value={value.mode ?? "cover"}
              onValueChange={(v) => onChange({ ...value, mode: v === "tile" ? "tile" : "cover" })}
            >
              <SelectTrigger className="h-9 w-24" aria-label="Background fit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cover">Fill</SelectItem>
                <SelectItem value="tile">Tile</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="icon"
              className="size-9 touch:size-11 text-muted-foreground hover:text-destructive"
              aria-label="Remove background"
              onClick={() => onChange(undefined)}
            >
              <Trash2 className="size-4" />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
