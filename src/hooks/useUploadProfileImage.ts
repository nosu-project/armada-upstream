import { useCallback } from "react";

import { getImageMeta } from "@/lib/imageProbe";
import { imetaTagFromUpload } from "@/lib/profileImeta";

import { useUploadFile } from "./useUploadFile";

/**
 * Upload a profile picture or banner and describe it as the kind 0's `imeta`
 * tag (see `profileImetaTags`): the upload's own tags, plus `dim` and
 * `blurhash` probed from the file while it uploads.
 */
export function useUploadProfileImage() {
  const { mutateAsync: uploadFile, isPending } = useUploadFile();

  const upload = useCallback(async (file: File): Promise<{ url: string; imeta: string[] }> => {
    const [tags, probed] = await Promise.all([uploadFile(file), getImageMeta(file)]);
    const all: string[][] = [...tags];
    // What the server reported about the blob wins.
    for (const [name, value] of Object.entries(probed)) {
      if (value && !all.some(([n]) => n === name)) all.push([name, value]);
    }
    return { url: tags[0][1], imeta: imetaTagFromUpload(all) };
  }, [uploadFile]);

  return { upload, isPending };
}
