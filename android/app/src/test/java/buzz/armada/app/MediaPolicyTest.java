package buzz.armada.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The service's port of {@code lib/mediaPolicy.ts}, checked against the same
 * cases as {@code mediaPolicy.test.ts}: a background avatar fetch must go to
 * exactly the address the WebView would have loaded the picture from.
 */
public class MediaPolicyTest {
    private static final String IMG = "https://henk.example/ip/ip.png";
    private static final String PROXIED =
            "https://proxy.shakespeare.diy/?url=https%3A%2F%2Fhenk.example%2Fip%2Fip.png";

    @Test public void proxiesAHostWhenAProxyIsSet() {
        assertEquals(PROXIED, new MediaPolicy(MediaPolicy.DEFAULT_PROXY).resolve(IMG));
    }

    @Test public void loadsDirectlyWithNoProxy() {
        assertEquals(IMG, new MediaPolicy("").resolve(IMG));
    }

    @Test public void localNetworkAddressesAreNeverFetchedOrProxied() {
        assertNull(new MediaPolicy(MediaPolicy.DEFAULT_PROXY).resolve("http://192.168.1.1/x.png"));
        assertNull(new MediaPolicy("").resolve("http://localhost:8080/x.png"));
        assertTrue(MediaPolicy.isLocalNetworkUrl("http://[::ffff:7f00:1]/x"));
        assertTrue(MediaPolicy.isLocalNetworkUrl("http://10.0.0.5/x"));
        assertTrue(MediaPolicy.isLocalNetworkUrl("http://172.20.1.1/x"));
        assertFalse(MediaPolicy.isLocalNetworkUrl("http://172.32.1.1/x"));
        assertFalse(MediaPolicy.isLocalNetworkUrl("https://henk.example/x"));
    }

    @Test public void nonHttpAndEmptyUrlsResolveToNothing() {
        MediaPolicy p = new MediaPolicy("");
        assertNull(p.resolve(null));
        assertNull(p.resolve(""));
        assertNull(p.resolve("data:image/png;base64,AAAA"));
        assertNull(p.resolve("ftp://host/x.png"));
    }

    @Test public void anAlreadyProxiedUrlIsNotWrappedTwice() {
        assertEquals(PROXIED, new MediaPolicy(MediaPolicy.DEFAULT_PROXY).resolve(PROXIED));
    }

    @Test public void proxyTemplateNormalizationMatchesTheWebView() {
        assertEquals("https://p.example/?url={href}", MediaPolicy.normalizeProxy("https://p.example/?url="));
        assertEquals("https://p.example/{+href}", MediaPolicy.normalizeProxy(" https://p.example/{+href} "));
        assertEquals("", MediaPolicy.normalizeProxy(""));
        assertEquals("", MediaPolicy.normalizeProxy(null));
        assertEquals("", MediaPolicy.normalizeProxy("javascript:alert(1)//{href}"));
        assertEquals("", MediaPolicy.normalizeProxy("not a url"));
    }

    @Test public void encodingMatchesEncodeUriComponent() {
        assertEquals("https%3A%2F%2Fa.example%2Fx%3Fy%3D1%26z%3D2%20w",
                MediaPolicy.encodeComponent("https://a.example/x?y=1&z=2 w"));
        assertEquals("https://p.example/https://a.example/x?y=1",
                MediaPolicy.fillTemplate("https://p.example/{+href}", "https://a.example/x?y=1"));
    }

    @Test public void parseReadsTheWebViewShapeAndDefaultsTheRest() {
        assertEquals("https://p.example/?u={href}",
                MediaPolicy.parse("{\"proxy\":\"https://p.example/?u=\"}").proxy);
        // An explicitly EMPTY proxy is a choice; an absent one is the default.
        assertEquals("", MediaPolicy.parse("{\"proxy\":\"\"}").proxy);
        assertEquals(MediaPolicy.DEFAULT_PROXY, MediaPolicy.parse("{}").proxy);
    }

    @Test public void missingOrBrokenConfigIsTheDefaultPolicyNotDirect() {
        for (String json : new String[] {null, "", "{", "[]"}) {
            MediaPolicy p = MediaPolicy.parse(json);
            assertEquals(MediaPolicy.DEFAULT_PROXY, p.proxy);
            assertEquals(PROXIED, p.resolve(IMG));
        }
    }
}
