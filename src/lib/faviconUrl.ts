import { fillUriTemplate } from "@/lib/uriTemplate";

/**
 * The favicon service, as a URI template. Ditto's default, and deliberately
 * the same one: a template rather than `<origin>/favicon.ico` means the icon
 * for an arbitrary host is fetched from ONE known service instead of from that
 * host, so rendering a list of hosts is not a round of requests announcing the
 * reader to each of them. Point it at `{origin}/favicon.ico` to opt back into
 * contacting hosts directly.
 */
export const FAVICON_URL_TEMPLATE = "https://ditto.pub/api/favicon/{hostname}";

export interface TemplateUrlOpts {
  template: string;
  url: string | URL;
}

/**
 * Fill a URI template with parts of the given URL.
 * Supports RFC 6570 variables: {url}, {href}, {origin}, {hostname}, etc.
 */
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

/**
 * The favicon URL for a host, or undefined when the input isn't a URL at all
 * (the caller then has nothing to render but its fallback).
 */
export function faviconUrl(url: string | URL, template: string = FAVICON_URL_TEMPLATE): string | undefined {
  try {
    return templateUrl({ template, url });
  } catch {
    return undefined;
  }
}
