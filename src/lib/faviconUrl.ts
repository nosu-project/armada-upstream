import { fillUriTemplate } from "@/lib/uriTemplate";

/**
 * Favicon service URI template (Ditto's default). A central service means
 * rendering a host list doesn't announce the reader to each host.
 * Use `{origin}/favicon.ico` to contact hosts directly.
 */
export const FAVICON_URL_TEMPLATE = "https://api.ditto.pub/favicon/{hostname}";

export interface TemplateUrlOpts {
  template: string;
  url: string | URL;
}

/** Fill an RFC 6570 URI template ({url}, {href}, {origin}, {hostname}, …) from a URL. */
export function templateUrl(opts: TemplateUrlOpts): string {
  const u = new URL(opts.url);

  return fillUriTemplate(opts.template, {
    url: u.href,
    href: u.href,
    origin: u.origin,
    protocol: u.protocol,
    username: u.username,
    password: u.password,
    host: u.host,
    hostname: u.hostname,
    port: u.port,
    pathname: u.pathname,
    hash: u.hash,
    search: u.search,
  });
}

/** Favicon URL for a host, or undefined when the input isn't a URL. */
export function faviconUrl(url: string | URL, template: string = FAVICON_URL_TEMPLATE): string | undefined {
  try {
    return templateUrl({ template, url });
  } catch {
    return undefined;
  }
}
