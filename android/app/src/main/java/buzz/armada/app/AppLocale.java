package buzz.armada.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.content.res.Resources;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * The app's chosen language for native text. The WebView sends it with every
 * configure; it lives in its own prefs file because the notification config is
 * cleared on disable/logout, while the language is device-wide (as on the web).
 * Unset or unknown means the device's language.
 */
final class AppLocale {
    private static final String PREFS = "armada_locale";
    private static final String KEY = "locale";
    /** The catalogs that ship, matching src/i18n/locales.ts and res/values-*. */
    private static final Set<String> SUPPORTED =
            new HashSet<>(Arrays.asList("en", "de", "es", "fr", "it", "nl", "ja"));

    private static String cachedTag;
    private static Context cachedContext;

    private AppLocale() {}

    /** The stored language tag, or null to follow the device. */
    static String get(Context ctx) {
        String tag = ctx.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null);
        return tag != null && SUPPORTED.contains(tag) ? tag : null;
    }

    /** Store {@code tag} (null/unknown clears it); true when the language changed. */
    static synchronized boolean set(Context ctx, String tag) {
        String next = tag != null && SUPPORTED.contains(tag) ? tag : null;
        String prev = get(ctx);
        if (next == null ? prev == null : next.equals(prev)) return false;
        SharedPreferences.Editor e = ctx.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        if (next != null) e.putString(KEY, next);
        else e.remove(KEY);
        e.apply();
        cachedTag = null;
        cachedContext = null;
        return true;
    }

    /** A context whose resources resolve in the app's language. */
    static synchronized Context context(Context ctx) {
        Context app = ctx.getApplicationContext();
        String tag = get(app);
        // The application context already follows the device's language.
        if (tag == null) return app;
        if (cachedContext != null && tag.equals(cachedTag)) return cachedContext;
        Configuration conf = new Configuration(app.getResources().getConfiguration());
        conf.setLocale(Locale.forLanguageTag(tag));
        cachedContext = app.createConfigurationContext(conf);
        cachedTag = tag;
        return cachedContext;
    }

    static Resources resources(Context ctx) {
        return context(ctx).getResources();
    }

    static String string(Context ctx, int id, Object... args) {
        return args.length == 0 ? resources(ctx).getString(id) : resources(ctx).getString(id, args);
    }
}
