import { useMediaSrc } from "@/hooks/useMediaPolicy";
import { isLocalNetworkUrl, sanitizeUrl } from "@/lib/sanitizeUrl";

/**
 * A group's NIP-29 banner image (the kind-39000 `banner` tag). The URL is
 * untrusted event data, so non-http(s) and local/private-network URLs are
 * refused (a leaked dev-instance URL would otherwise trigger Chrome's Local
 * Network Access prompt for every viewer), and it loads under the viewer's
 * media policy like every other sender-named image — proxied for a stranger's
 * host, absent when the policy wants a tap first. Renders nothing when
 * invalid; the parent owns the container (height, rounding).
 */
export function GroupBannerImage({ src, className }: { src: string | undefined; className?: string }) {
  const url = sanitizeUrl(src);
  const load = useMediaSrc(url && !isLocalNetworkUrl(url) ? url : undefined);
  if (!load) return null;
  return <img src={load} alt="" loading="lazy" className={className} />;
}
