package buzz.armada.app;

import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Parcelable;
import android.provider.OpenableColumns;
import android.util.Log;

import androidx.core.app.Person;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;

/**
 * Android share-target bridge: stages ACTION_SEND / ACTION_SEND_MULTIPLE
 * payloads (text and content:// streams) arriving at MainActivity for the web
 * layer, and publishes the ranked conversation shortcuts that surface as
 * Direct Share suggestions in other apps' share sheets.
 *
 * <p>Capacitor's @capacitor/app plugin only surfaces ACTION_VIEW intents
 * (getLaunchUrl / appUrlOpen), so a share intent would otherwise be delivered
 * to the activity and silently dropped. This plugin captures it on both the
 * cold path (the launch intent, read in {@link #load}) and the warm path
 * ({@link #handleOnNewIntent}), then hands it to JS on request: shared
 * streams are copied into the app cache so the WebView can fetch them through
 * Capacitor's file bridge after the sender's URI grant is gone.
 */
@CapacitorPlugin(name = "ShareTarget")
public class ShareTargetPlugin extends Plugin {
    private static final String TAG = "ShareTarget";

    /**
     * The category tying dynamic conversation shortcuts to the static
     * <share-target> in res/xml/shortcuts.xml. Both shortcut writers — this
     * plugin and NotificationRelayService.pushConversationShortcut — must set
     * it, or the shortcut never appears in share sheets.
     */
    static final String CATEGORY_SHARE_TARGET = "buzz.armada.app.category.SHARE_TARGET";

    /** Launcher conversation-space category (matches the service's pushes). */
    static final String CATEGORY_CONVERSATION = "android.shortcut.conversation";

    /** Marks a launch intent whose share payload JS has already consumed, so an
     *  activity/bridge re-init (process restore) doesn't replay the share. */
    private static final String EXTRA_CONSUMED = "armada.share.consumed";

    private static final int MAX_FILES = 10;
    private static final long CACHE_MAX_AGE_MS = 24L * 60 * 60 * 1000;

    /** The pending share intent, staged until JS calls checkShare. */
    private volatile Intent staged;

    @Override
    public void load() {
        Intent intent = getActivity() != null ? getActivity().getIntent() : null;
        if (isShareIntent(intent)) staged = intent;
        // Shared streams are copied into cache for the WebView to fetch; a
        // payload the user abandoned (never picked a destination) would
        // otherwise sit there forever.
        new Thread(this::pruneShareCache).start();
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (isShareIntent(intent)) {
            staged = intent;
            notifyListeners("shareReceived", new JSObject());
        }
    }

    /** A share intent that hasn't been consumed yet. */
    static boolean isShareIntent(Intent intent) {
        if (intent == null || intent.getBooleanExtra(EXTRA_CONSUMED, false)) return false;
        String action = intent.getAction();
        return Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action);
    }

    /**
     * Non-consuming, copy-free look at the staged share: whether one is
     * pending and which Direct Share shortcut (if any) it targets. Lets the
     * web layer commit to a destination route immediately, before checkShare's
     * stream copies (potentially a large video) have run.
     */
    @PluginMethod
    public void peekShare(PluginCall call) {
        Intent intent = staged;
        JSObject ret = new JSObject();
        ret.put("pending", intent != null);
        if (intent != null) {
            String shortcutId = intent.getStringExtra(Intent.EXTRA_SHORTCUT_ID);
            if (shortcutId != null) ret.put("shortcutId", shortcutId);
        }
        call.resolve(ret);
    }

    /**
     * Return-and-clear the staged share, copying any shared streams into the
     * app cache. Resolves {pending: false} when there is nothing staged.
     * Runs on Capacitor's plugin thread, so the stream copies don't jank UI.
     */
    @PluginMethod
    public void checkShare(PluginCall call) {
        Intent intent = staged;
        staged = null;
        JSObject ret = new JSObject();
        if (intent == null) {
            ret.put("pending", false);
            call.resolve(ret);
            return;
        }
        // The cold-path staged intent IS the activity's launch intent; flag it
        // so a bridge re-init doesn't re-stage it in load().
        intent.putExtra(EXTRA_CONSUMED, true);

        ret.put("pending", true);
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (text != null) ret.put("text", text);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        if (subject != null) ret.put("subject", subject);
        // A Direct Share tap: the tapped shortcut's id is the in-app route of
        // the conversation the user picked (see shortcuts.xml).
        String shortcutId = intent.getStringExtra(Intent.EXTRA_SHORTCUT_ID);
        if (shortcutId != null) ret.put("shortcutId", shortcutId);

        JSArray files = new JSArray();
        for (Uri uri : sharedUris(intent)) {
            JSObject file = copyToShareCache(uri, intent.getType());
            if (file != null) files.put(file);
        }
        ret.put("files", files);
        call.resolve(ret);
    }

    /**
     * Publish the ranked Direct Share conversation suggestions. Input:
     * {shortcuts: [{id, label, iconUrl?}]} in rank order (best first). The id
     * is the conversation's in-app route; iconUrl is the avatar to fetch —
     * fetched HERE (native, like the notification service's avatar fetches)
     * because a WebView fetch of an arbitrary avatar host dies on CORS.
     * Pushed one at a time so they MERGE with the notification service's
     * per-message pushes (same id updates in place) instead of clobbering
     * them; pushDynamicShortcut evicts the lowest-ranked when full.
     */
    @PluginMethod
    public void publishShortcuts(PluginCall call) {
        JSArray arr = call.getArray("shortcuts");
        if (arr == null) {
            call.reject("shortcuts required");
            return;
        }
        int published = 0;
        for (int i = 0; i < arr.length(); i++) {
            try {
                JSObject item = JSObject.fromJSONObject(arr.getJSONObject(i));
                String id = item.getString("id");
                String label = item.getString("label");
                if (id == null || id.isEmpty() || label == null || label.isEmpty()) continue;
                ShortcutInfoCompat.Builder sb = new ShortcutInfoCompat.Builder(getContext(), id)
                        .setShortLabel(label)
                        .setLongLived(true)
                        .setRank(i)
                        .setIntent(deepLinkIntent(id))
                        .setPerson(new Person.Builder().setName(label).setKey(id).build())
                        .setCategories(new HashSet<>(Arrays.asList(
                                CATEGORY_CONVERSATION, CATEGORY_SHARE_TARGET)));
                String iconUrl = item.getString("iconUrl");
                if (iconUrl != null && !iconUrl.isEmpty()) {
                    IconCompat icon = fetchIcon(iconUrl);
                    if (icon != null) sb.setIcon(icon);
                }
                ShortcutManagerCompat.pushDynamicShortcut(getContext(), sb.build());
                published++;
            } catch (Exception e) {
                if (BuildConfig.DEBUG) Log.w(TAG, "publishShortcuts item failed", e);
            }
        }
        JSObject ret = new JSObject();
        ret.put("published", published);
        call.resolve(ret);
    }

    /** Avatar px for shortcut icons (matches the service's AVATAR_PX look). */
    private static final int ICON_PX = 108;
    /** Refuse to buffer avatar responses beyond this (a decoy "avatar"). */
    private static final int ICON_MAX_BYTES = 5 * 1024 * 1024;

    /** Session cache so a re-publish doesn't refetch every avatar. */
    private final java.util.Map<String, IconCompat> iconCache = new java.util.HashMap<>();

    /**
     * Fetch + downscale + circle-crop an avatar into a shortcut icon.
     * Best-effort: null on any failure, and the shortcut ships icon-less.
     */
    private IconCompat fetchIcon(String url) {
        IconCompat cached = iconCache.get(url);
        if (cached != null) return cached;
        try {
            java.net.HttpURLConnection conn =
                    (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);
            conn.setInstanceFollowRedirects(true);
            byte[] data;
            try (InputStream in = conn.getInputStream();
                 java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream()) {
                byte[] chunk = new byte[16 * 1024];
                int n;
                while ((n = in.read(chunk)) > 0) {
                    if (buf.size() + n > ICON_MAX_BYTES) return null;
                    buf.write(chunk, 0, n);
                }
                data = buf.toByteArray();
            } finally {
                conn.disconnect();
            }
            Bitmap src = BitmapFactory.decodeByteArray(data, 0, data.length);
            if (src == null) return null;
            Bitmap out = Bitmap.createBitmap(ICON_PX, ICON_PX, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(out);
            Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
            canvas.drawCircle(ICON_PX / 2f, ICON_PX / 2f, ICON_PX / 2f, paint);
            paint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN));
            // Center-crop the source's largest square into the circle.
            int side = Math.min(src.getWidth(), src.getHeight());
            int left = (src.getWidth() - side) / 2;
            int top = (src.getHeight() - side) / 2;
            canvas.drawBitmap(src,
                    new Rect(left, top, left + side, top + side),
                    new Rect(0, 0, ICON_PX, ICON_PX), paint);
            IconCompat icon = IconCompat.createWithBitmap(out);
            iconCache.put(url, icon);
            return icon;
        } catch (Exception e) {
            if (BuildConfig.DEBUG) Log.d(TAG, "shortcut icon fetch failed: " + e.getMessage());
            return null;
        }
    }

    /** Drop all dynamic conversation shortcuts (logout: suggestions would
     *  otherwise keep naming the previous account's conversations). */
    @PluginMethod
    public void clearShortcuts(PluginCall call) {
        try {
            ShortcutManagerCompat.removeAllDynamicShortcuts(getContext());
        } catch (Exception e) {
            if (BuildConfig.DEBUG) Log.w(TAG, "clearShortcuts failed", e);
        }
        call.resolve();
    }

    /**
     * Mirror of NotificationRelayService.deepLinkIntent: ACTION_VIEW is what
     * @capacitor/app surfaces to JS when the shortcut is tapped from the
     * launcher (not through a share sheet).
     */
    private Intent deepLinkIntent(String path) {
        Intent intent = new Intent(getContext(), MainActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(Uri.parse("armada://open" + path));
        intent.putExtra("armada_path", path);
        return intent;
    }

    private List<Uri> sharedUris(Intent intent) {
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            Parcelable p = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (p instanceof Uri && isAcceptableSharedUri((Uri) p)) uris.add((Uri) p);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            List<Parcelable> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) {
                for (Parcelable p : list) {
                    if (p instanceof Uri && isAcceptableSharedUri((Uri) p)) uris.add((Uri) p);
                    if (uris.size() >= MAX_FILES) break;
                }
            }
        }
        return uris;
    }

    /**
     * Whether a URI handed to us in EXTRA_STREAM may be opened.
     *
     * The share filter is exported and accepts any MIME type from any app with
     * no permission, so this URI is fully attacker-controlled — and
     * {@link ContentResolver#openInputStream} runs as US. Two refusals:
     *
     * <ul>
     *   <li><b>Anything but {@code content://}.</b> {@code openInputStream}
     *       accepts {@code file://} and resolves it as a plain FileInputStream
     *       under our own UID, so a sender who cannot read a file can name it
     *       and have Armada read it for them. Pointed at
     *       {@code /data/data/buzz.armada.app/databases/armada-db.sqlite} that
     *       is the decrypted NIP-17 and Concord history plus the Concord stream
     *       secrets — the entire corpus this app exists to protect. The rest of
     *       the intent completes the loop: EXTRA_SHORTCUT_ID picks the DM the
     *       file is staged into, so the attacker addresses it to themselves.
     *   <li><b>A provider we own.</b> Our own FileProvider can hand out our
     *       private files to us for the same reason, so authority alone is not
     *       a safe substitute for the scheme check — both are needed.
     * </ul>
     *
     * A sender's own {@code content://} URI is fine: it arrives with a grant,
     * and the sender could read it anyway. The display name is separately
     * distrusted by {@link #sanitizeName}.
     */
    private boolean isAcceptableSharedUri(Uri uri) {
        if (uri == null) return false;
        if (!ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            if (BuildConfig.DEBUG) Log.w(TAG, "refusing shared URI with non-content scheme");
            return false;
        }
        String authority = uri.getAuthority();
        if (authority == null || authority.isEmpty()) return false;
        try {
            // A null result is left to pass. Package-visibility filtering can
            // hide another app's provider from us, and our OWN provider is
            // never hidden from us — so an unresolvable authority cannot be
            // the case this check is for, and refusing it would only break
            // ordinary shares.
            ProviderInfo info = getContext().getPackageManager().resolveContentProvider(authority, 0);
            if (info != null && getContext().getPackageName().equals(info.packageName)) {
                if (BuildConfig.DEBUG) Log.w(TAG, "refusing shared URI backed by our own provider");
                return false;
            }
        } catch (Exception e) {
            if (BuildConfig.DEBUG) Log.w(TAG, "refusing unresolvable shared URI authority", e);
            return false;
        }
        return true;
    }

    /**
     * Copy one shared stream into cache/share/ and describe it for JS: the
     * sender's URI grant dies with its task, but a file in our own cache stays
     * readable for the WebView's fetch (via Capacitor.convertFileSrc).
     */
    private JSObject copyToShareCache(Uri uri, String intentType) {
        try {
            ContentResolver resolver = getContext().getContentResolver();
            String type = resolver.getType(uri);
            if (type == null) type = intentType != null ? intentType : "application/octet-stream";
            String name = displayNameOf(resolver, uri);
            File dir = new File(getContext().getCacheDir(), "share");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            File out = new File(dir, System.nanoTime() + "-" + sanitizeName(name));
            try (InputStream in = resolver.openInputStream(uri);
                 OutputStream os = new FileOutputStream(out)) {
                if (in == null) return null;
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            }
            JSObject file = new JSObject();
            file.put("name", name);
            file.put("type", type);
            file.put("size", out.length());
            file.put("path", out.getAbsolutePath());
            return file;
        } catch (Exception e) {
            if (BuildConfig.DEBUG) Log.w(TAG, "share stream copy failed", e);
            return null;
        }
    }

    private static String displayNameOf(ContentResolver resolver, Uri uri) {
        try (Cursor c = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String name = c.getString(0);
                if (name != null && !name.isEmpty()) return name;
            }
        } catch (Exception ignored) {
            // Fall through to the URI's last segment.
        }
        String seg = uri.getLastPathSegment();
        return seg != null && !seg.isEmpty() ? seg : "shared";
    }

    /** Keep only a safe basename: a display name is attacker-ish input and
     *  must not traverse out of the cache dir. */
    private static String sanitizeName(String name) {
        String base = name.replace('\\', '/');
        int slash = base.lastIndexOf('/');
        if (slash >= 0) base = base.substring(slash + 1);
        base = base.replaceAll("[^A-Za-z0-9._-]", "_");
        return base.isEmpty() ? "shared" : base;
    }

    private void pruneShareCache() {
        try {
            File dir = new File(getContext().getCacheDir(), "share");
            File[] files = dir.listFiles();
            if (files == null) return;
            long cutoff = System.currentTimeMillis() - CACHE_MAX_AGE_MS;
            for (File f : files) {
                if (f.lastModified() < cutoff) {
                    //noinspection ResultOfMethodCallIgnored
                    f.delete();
                }
            }
        } catch (Exception ignored) {
            // Best-effort cleanup.
        }
    }
}
