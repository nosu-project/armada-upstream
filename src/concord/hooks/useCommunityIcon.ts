import { useEffect } from "react";

import { useDecryptedImage } from "@/concord/hooks/useDecryptedImage";
import {
  deleteIconThumb,
  makeIconThumb,
  readIconThumb,
  writeIconThumb,
} from "@/concord/lib/iconThumbs";
import type { ImagePointer } from "@/concord/lib/types";
import { useBlossomServers } from "@/hooks/useBlossomServers";
import { useMediaPolicy } from "@/hooks/useMediaPolicy";

/**
 * A community's rail-sized icon: the stored thumbnail from the first frame, the
 * decrypted original only while that is missing or stale. `icon` is undefined
 * until the fold is known and null when the community has none.
 */
export function useCommunityIcon(
  communityId: string | undefined,
  icon: ImagePointer | null | undefined,
): string | null {
  const thumb = communityId ? readIconThumb(communityId) : undefined;
  const fresh = Boolean(thumb) && (icon === undefined || icon?.hash === thumb?.hash);
  const live = useDecryptedImage(fresh || !icon ? undefined : icon);
  const servers = useBlossomServers();
  const policy = useMediaPolicy();

  const state = icon === undefined ? undefined : (icon?.hash ?? null);
  useEffect(() => {
    if (!communityId || icon === undefined) return;
    if (icon === null) {
      if (readIconThumb(communityId)) deleteIconThumb(communityId);
      return;
    }
    if (readIconThumb(communityId)?.hash === icon.hash) return;
    let cancelled = false;
    void makeIconThumb(icon, servers, policy).then((url) => {
      if (!cancelled && url) writeIconThumb(communityId, { hash: icon.hash, url });
    });
    return () => {
      cancelled = true;
    };
    // Keyed on the icon's identity; servers and policy are read once per thumbnail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [communityId, state]);

  if (fresh && thumb) return thumb.url;
  if (icon === null) return null;
  return live ?? thumb?.url ?? null;
}
