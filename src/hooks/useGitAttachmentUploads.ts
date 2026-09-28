import { useCallback, useRef, useState } from "react";

import { useUploadFile } from "@/hooks/useUploadFile";
import { toast } from "@/hooks/useToast";

/** One NIP-92 imeta tag from the NIP-94-style tags an upload returns. */
export function imetaTagFromNip94(fileTags: string[][]): string[] {
  return ["imeta", ...fileTags.map((tag) => `${tag[0]} ${tag[1]}`)];
}

/**
 * Uploads picked files to Blossom, appends each URL to the text, and remembers its imeta so
 * submit attaches NIP-92 metadata for every URL still present.
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

  // Whole-token matching, so a URL prefixing a longer one doesn't attach the wrong imeta.
  const mediaFor = useCallback(
    (content: string) => {
      const tokens = new Set(content.split(/\s+/));
      return [...uploaded.current].filter(([url]) => tokens.has(url)).map(([, tag]) => tag);
    },
    [],
  );

  return { attach, isUploading: pendingUploads > 0, mediaFor };
}
