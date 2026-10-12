package buzz.armada.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import okhttp3.ResponseBody;
import okio.Buffer;

import org.junit.Test;

/**
 * Bounds on the service's long-lived maps and image reads. android.jar is a
 * stub here, so the service is allocated without running its constructor and
 * only the fields a method touches are filled in.
 */
public class NotificationRelayServiceCacheTest {

    private static Object allocate(Class<?> cls) throws Exception {
        Class<?> c = Class.forName("sun.misc.Unsafe");
        Field f = c.getDeclaredField("theUnsafe");
        f.setAccessible(true);
        Object u = f.get(null);
        return u.getClass().getMethod("allocateInstance", Class.class).invoke(u, cls);
    }

    private static void set(Object target, String name, Object value) throws Exception {
        Field f = target.getClass().getDeclaredField(name);
        f.setAccessible(true);
        f.set(target, value);
    }

    private static Method alertAllowed() throws Exception {
        Method m = NotificationRelayService.class.getDeclaredMethod("alertAllowed", String.class, boolean.class);
        m.setAccessible(true);
        return m;
    }

    @Test
    public void quietRoomsAreSweptOnceTheMapGrows() throws Exception {
        Object svc = allocate(NotificationRelayService.class);
        Map<String, ArrayDeque<Long>> alert = new HashMap<>();
        set(svc, "alertBurst", alert);
        set(svc, "mentionBurst", new HashMap<String, ArrayDeque<Long>>());
        long stale = System.currentTimeMillis() - 10 * 60_000L;
        for (int i = 0; i < 100; i++) {
            ArrayDeque<Long> t = new ArrayDeque<>();
            t.add(stale);
            alert.put("old-" + i, t);
        }
        alertAllowed().invoke(svc, "live", false);
        assertEquals(1, alert.size());
        assertTrue(alert.containsKey("live"));
    }

    @Test
    public void sweepKeepsAFloodQuiet() throws Exception {
        Object svc = allocate(NotificationRelayService.class);
        Map<String, ArrayDeque<Long>> alert = new HashMap<>();
        set(svc, "alertBurst", alert);
        set(svc, "mentionBurst", new HashMap<String, ArrayDeque<Long>>());
        Method m = alertAllowed();
        for (int i = 0; i < 5; i++) assertTrue((Boolean) m.invoke(svc, "flood", false));
        assertFalse((Boolean) m.invoke(svc, "flood", false));
        // Enough other rooms to trigger sweeps; the flood's window is live.
        for (int i = 0; i < 200; i++) m.invoke(svc, "room-" + i, false);
        assertFalse((Boolean) m.invoke(svc, "flood", false));
        // Mentions draw on their own budget.
        assertTrue((Boolean) m.invoke(svc, "flood", true));
    }

    @Test
    public void readCappedRefusesADeclaredOversizeBody() throws Exception {
        Buffer b = new Buffer().write(new byte[10]);
        assertNull(NotificationRelayService.readCapped(ResponseBody.create(b, null, 1000L), 100));
    }

    @Test
    public void readCappedRefusesAnUnknownLengthBodyPastTheCap() throws Exception {
        Buffer b = new Buffer().write(new byte[101]);
        assertNull(NotificationRelayService.readCapped(ResponseBody.create(b, null, -1L), 100));
    }

    @Test
    public void readCappedReturnsABodyAtTheCap() throws Exception {
        byte[] payload = new byte[100];
        payload[0] = 7;
        Buffer b = new Buffer().write(payload);
        assertArrayEquals(payload, NotificationRelayService.readCapped(ResponseBody.create(b, null, -1L), 100));
    }

    @Test
    public void connectDropsAuthIdsOfTheDroppedSession() throws Exception {
        // connect() reaches ConnectivityManager before the reset, which the
        // android.jar stub can't run, so this checks the reset list itself.
        Path p = Paths.get("src/main/java/buzz/armada/app/NotificationRelayService.java");
        if (!Files.exists(p)) p = Paths.get("app").resolve(p);
        String src = new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
        Matcher m = Pattern.compile("\\n\\s*void connect\\(\\)\\s*\\{").matcher(src);
        assertTrue(m.find());
        int start = src.indexOf('{', m.end() - 1);
        int depth = 0;
        int end = start;
        for (int j = start; j < src.length(); j++) {
            char ch = src.charAt(j);
            if (ch == '{') depth++;
            else if (ch == '}' && --depth == 0) { end = j; break; }
        }
        String body = src.substring(start, end);
        assertTrue(body.contains("answeredAuth.clear()"));
        assertTrue(body.contains("pendingAuthIds.clear()"));
    }
}
