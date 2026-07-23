import { isLocalNetworkUrl, sanitizeUrl } from "@/lib/sanitizeUrl";

/**
 * A group's NIP-29 banner image (the kind-39000 `banner` tag). The URL is
 * untrusted event data, so non-http(s) and local/private-network URLs are
 * refused (a leaked dev-instance URL would otherwise trigger Chrome's Local
 * Network Access prompt for every viewer). Renders nothing when invalid; the
 * parent owns the container (height, rounding).
 */
export function GroupBannerImage({ src, className }: { src: string | undefined; className?: string }) {
  const url = sanitizeUrl(src);
  if (!url || isLocalNetworkUrl(url)) return null;
  return <img src={url} alt="" loading="lazy" className={className} />;
}
