import { useCallback, useRef, useState } from "react";

import { useUploadFile } from "@/hooks/useUploadFile";
import { toast } from "@/hooks/useToast";

/** One NIP-92 imeta tag from the NIP-94-style tags an upload returns. */
export function imetaTagFromNip94(fileTags: string[][]): string[] {
  return ["imeta", ...fileTags.map((tag) => `${tag[0]} ${tag[1]}`)];
}

/**
 * GitHub-style attachments for git work-item composers: each picked file is
 * uploaded to the user's Blossom servers, its public URL appended to the text
 * (what you see is what publishes), and its imeta remembered so submit can
 * attach NIP-92 metadata for every URL still present in the final text.
 */
export function useGitAttachmentUploads(appendText: (url: string) => void) {
  const { mutateAsync: uploadFile } = useUploadFile();
  const uploaded = useRef(new Map<string, string[]>());
  const [pendingUploads, setPendingUploads] = useState(0);

  const attach = useCallback(async (files: FileList | File[] | null) => {
    for (const file of files ?? []) {
      setPendingUploads((count) => count + 1);
      try {
        const tags = await uploadFile(file);
        const url = tags[0][1];
        uploaded.current.set(url, imetaTagFromNip94(tags));
        appendText(url);
      } catch (error) {
        toast({
          title: "Couldn't upload attachment",
          description: error instanceof Error ? error.message : undefined,
          variant: "destructive",
        });
      } finally {
        setPendingUploads((count) => count - 1);
      }
    }
  }, [appendText, uploadFile]);

  // Deleting a pasted URL from the text detaches its file.
  const mediaFor = useCallback(
    (content: string) => [...uploaded.current].filter(([url]) => content.includes(url)).map(([, tag]) => tag),
    [],
  );

  return { attach, isUploading: pendingUploads > 0, mediaFor };
}
