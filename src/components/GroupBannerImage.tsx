import { useMediaSrc } from "@/hooks/useMediaPolicy";
import { isLocalNetworkUrl, sanitizeUrl } from "@/lib/sanitizeUrl";

/**
 * NIP-29 banner (kind-39000 `banner` tag). Untrusted: non-http(s) and
 * private-network URLs are refused (Chrome's Local Network Access prompt), and
 * it loads under the viewer's media policy.
 */
export function GroupBannerImage({ src, className }: { src: string | undefined; className?: string }) {
  const url = sanitizeUrl(src);
  const load = useMediaSrc(url && !isLocalNetworkUrl(url) ? url : undefined);
  if (!load) return null;
  return <img src={load} alt="" loading="lazy" className={className} />;
}
