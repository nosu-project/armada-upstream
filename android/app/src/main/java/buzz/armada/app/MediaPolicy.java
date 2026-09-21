package buzz.armada.app;

import org.json.JSONObject;

import java.io.UnsupportedEncodingException;
import java.net.URI;
import java.net.URLEncoder;
import java.util.Locale;

/**
 * Where a sender-named image is fetched FROM, decided the same way the WebView
 * decides it — the port of {@code src/lib/mediaPolicy.ts}, for the two fetches
 * the background service makes unprompted: a sender's kind-0 avatar and a
 * community's icon. Keep the two (and {@code MediaPolicy.swift}) in step.
 *
 * <p>An avatar fetch is a request from the phone's address to whatever host the
 * sender's profile names, made while the app is dead, for every message that
 * notifies. So the one control applies here too: a PROXY. With a proxy set,
 * the fetch goes through it and the host sees the proxy's address; with none,
 * the fetch is direct. A loopback/private address is never proxied (a public
 * proxy cannot reach it) and never fetched, so it resolves to null.
 *
 * <p>Pure: no Android imports, so it runs under the JVM unit tests.
 */
final class MediaPolicy {
    /** Ditto's default CORS proxy — a byte-for-byte pass-through. */
    static final String DEFAULT_PROXY = "https://proxy.shakespeare.diy/?url={href}";

    /** Normalized proxy template, or "" for none. */
    final String proxy;

    MediaPolicy(String proxy) {
        this.proxy = normalizeProxy(proxy);
    }

    /** The policy a fresh install has: the default proxy on. */
    static MediaPolicy defaults() {
        return new MediaPolicy(DEFAULT_PROXY);
    }

    /**
     * Parse the {@code mediaPolicy} object the WebView ships ({@code {proxy}}).
     * A missing or unreadable one is the default policy, never "load directly":
     * an older WebView that sends nothing still proxies a stranger's avatar.
     */
    static MediaPolicy parse(String json) {
        if (json == null || json.isEmpty()) return defaults();
        try {
            return parse(new JSONObject(json));
        } catch (Exception e) {
            return defaults();
        }
    }

    static MediaPolicy parse(JSONObject obj) {
        if (obj == null || !obj.has("proxy")) return defaults();
        return new MediaPolicy(obj.optString("proxy", ""));
    }

    /**
     * The URL to fetch {@code url} from, or null when the policy would not
     * fetch it at all (a loopback/private address). Mirrors {@code mediaSrc}.
     */
    String resolve(String url) {
        if (url == null || url.isEmpty()) return null;
        String scheme = schemeOf(url);
        if (!"https".equals(scheme) && !"http".equals(scheme)) return null;
        // Never fetched and never proxied: a public proxy cannot reach it, and
        // the attempt would tell it the address.
        if (isLocalNetworkUrl(url)) return null;
        return proxy.isEmpty() ? url : proxyUrl(url);
    }

    /** {@code url} through the proxy template, or unchanged when already on it. */
    String proxyUrl(String url) {
        if (proxy.isEmpty()) return url;
        // The template's braces are not URI characters, so the proxy's own
        // host is read off a filled probe rather than the template itself.
        String proxyHost = hostOf(fillTemplate(proxy, "https://example.com/x"));
        String host = hostOf(url);
        if (proxyHost != null && proxyHost.equals(host)) return url;
        return fillTemplate(proxy, url);
    }

    // ── Pure helpers ────────────────────────────────────────────────────────

    /**
     * The stored form of a proxy template: trimmed, http(s) once filled, and
     * carrying a placeholder (appended to a bare prefix). Returns "" for
     * anything unusable, which reads as "no proxy".
     *
     * <p>A bare prefix ending in {@code =} is a query parameter value
     * ({@code ?url=}) and takes the percent-encoded {@code {href}}; anything
     * else — a bare {@code ?} or a path — takes the URL RAW via {@code {+href}},
     * which is what corsfix-style proxies want. Mirrors {@code normalizeMediaProxy}.
     */
    static String normalizeProxy(String raw) {
        if (raw == null) return "";
        String trimmed = raw.trim();
        if (trimmed.isEmpty()) return "";
        String probe = fillTemplate(trimmed, "https://example.com/x");
        String scheme = schemeOf(probe);
        if (!"https".equals(scheme) && !"http".equals(scheme)) return "";
        if (hostOf(probe) == null) return "";
        if (trimmed.contains("{href}") || trimmed.contains("{+href}")) return trimmed;
        return trimmed.endsWith("=") ? trimmed + "{href}" : trimmed + "{+href}";
    }

    /**
     * RFC 6570 simple ({@code {href}}, percent-encoded like
     * {@code encodeURIComponent}) and reserved ({@code {+href}}, kept raw)
     * expansion of the one variable the templates use.
     */
    static String fillTemplate(String template, String href) {
        return template.replace("{+href}", href).replace("{href}", encodeComponent(href));
    }

    /** {@code encodeURIComponent}'s encoding, from {@link URLEncoder}'s form-encoding. */
    static String encodeComponent(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8")
                    .replace("+", "%20")
                    .replace("%21", "!")
                    .replace("%27", "'")
                    .replace("%28", "(")
                    .replace("%29", ")")
                    .replace("%7E", "~");
        } catch (UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Lowercase scheme of a URL string, or null. */
    static String schemeOf(String url) {
        int colon = url.indexOf(':');
        if (colon <= 0) return null;
        String scheme = url.substring(0, colon);
        for (int i = 0; i < scheme.length(); i++) {
            char c = scheme.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (i > 0 && ((c >= '0' && c <= '9') || c == '+' || c == '-' || c == '.'));
            if (!ok) return null;
        }
        return scheme.toLowerCase(Locale.ROOT);
    }

    /** Lowercase hostname of a URL (IPv6 brackets stripped), or null. */
    static String hostOf(String url) {
        if (url == null || url.isEmpty()) return null;
        try {
            String host = new URI(url).getHost();
            if (host == null || host.isEmpty()) return null;
            return host.toLowerCase(Locale.ROOT).replaceAll("^\\[|\\]$", "");
        } catch (Exception e) {
            return null;
        }
    }

    /** The port of {@code isLocalNetworkUrl} in {@code sanitizeUrl.ts}. */
    static boolean isLocalNetworkUrl(String url) {
        String h = hostOf(url);
        if (h == null) return false;
        if (h.equals("localhost") || h.endsWith(".localhost") || h.endsWith(".local")) return true;
        if (h.equals("::1") || h.equals("0.0.0.0")) return true;
        // An IPv4-mapped address reaches the same host by another spelling.
        String mapped = null;
        if (h.startsWith("::ffff:")) {
            String rest = h.substring(7);
            if (rest.matches("\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}")) {
                mapped = rest;
            } else if (rest.matches("[0-9a-f]{1,4}:[0-9a-f]{1,4}")) {
                String[] parts = rest.split(":");
                int n = (Integer.parseInt(parts[0], 16) << 16) | Integer.parseInt(parts[1], 16);
                mapped = ((n >>> 24) & 255) + "." + ((n >>> 16) & 255) + "." + ((n >>> 8) & 255) + "." + (n & 255);
            }
        }
        if (mapped != null) h = mapped;
        if (h.matches("\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}")) {
            String[] p = h.split("\\.");
            int a = Integer.parseInt(p[0]);
            int b = Integer.parseInt(p[1]);
            if (a == 127 || a == 10 || a == 0) return true;
            if (a == 192 && b == 168) return true;
            if (a == 172 && b >= 16 && b <= 31) return true;
            if (a == 169 && b == 254) return true;
        }
        if (h.matches("^f[cd][0-9a-f]*:.*")) return true; // fc00::/7
        if (h.matches("^fe[89ab][0-9a-f]*:.*")) return true; // fe80::/10
        return false;
    }
}
