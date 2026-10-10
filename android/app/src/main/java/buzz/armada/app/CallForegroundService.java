package buzz.armada.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Base64;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.drawable.IconCompat;

/**
 * The ongoing-call foreground service: the persistent "you are in a voice call"
 * notification, and the process protection that makes a backgrounded call keep
 * working.
 *
 * The call itself lives entirely in the WebView (LiveKit, in CallProvider's
 * PersistentVoiceRoom); this service holds no connection and knows nothing
 * about the room. It exists for the two things only a foreground service can
 * buy the process it runs in:
 *
 *   - The app stops being a CACHED process while backgrounded. Android 12+
 *     freezes cached processes within seconds, which stalls the LiveKit
 *     websocket and its keepalives; the room then fails to reconnect and the
 *     user is dropped from the call for having looked at another app.
 *   - Microphone capture keeps working. Since Android 11 a backgrounded app's
 *     capture returns silence unless it holds a foreground service typed
 *     {@code microphone} — without which the user stays in the call but is
 *     heard by nobody.
 *
 * Started/stopped by {@link ArmadaCallPlugin} from the web layer's call
 * lifecycle (see {@code useCallForegroundService.ts}).
 */
public class CallForegroundService extends Service {
    private static final String TAG = "CallForegroundService";
    private static final String CHANNEL_ID = "armada_call";
    private static final int NOTIF_ID = 4712;

    /** Set/refresh the ongoing notification (extras carry the labels). */
    static final String ACTION_UPDATE = "buzz.armada.app.action.CALL_UPDATE";
    /** The notification's hang-up button. */
    static final String ACTION_HANGUP = "buzz.armada.app.action.CALL_HANGUP";
    /** The notification's mute button. */
    static final String ACTION_TOGGLE_MUTE = "buzz.armada.app.action.CALL_TOGGLE_MUTE";

    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";
    static final String EXTRA_ICON = "icon";

    /**
     * How often to re-check RECORD_AUDIO while it is still ungranted, so the
     * {@code microphone} type can be added the moment it is. Calls are joined
     * MUTED (VoiceRoomShell passes {@code audio={false}}), so on a first-ever
     * call the permission does not exist yet when this service starts, and the
     * user may unmute at any point afterwards. A checkSelfPermission every few
     * seconds costs nothing and the poll stops for good on the first grant.
     */
    private static final long MIC_POLL_MS = 5000;

    /** Static so a report never starts the service (and can't resurrect it after a hang-up). */
    @Nullable
    private static volatile Boolean micMuted;
    private static volatile boolean micPublished;
    @Nullable
    private static CallForegroundService live;

    /** Set before stopService(): a CallStyle notify() before onDestroy throws. */
    private static volatile boolean stopping;

    static void markStopping() {
        stopping = true;
    }

    static void updateMic(boolean muted, boolean published) {
        micMuted = muted;
        micPublished = published;
        new Handler(Looper.getMainLooper()).post(() -> {
            if (live != null && live.foregrounded && !stopping) live.refreshNotification();
        });
    }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean foregrounded = false;
    /** Whether the microphone type is already part of our foreground state. */
    private boolean micTyped = false;
    private boolean micPollScheduled = false;
    private String title = "Voice call";
    private String text = "";
    @Nullable
    private Bitmap icon;
    private String iconSource = "";
    private final long startedAt = System.currentTimeMillis();

    @Nullable
    private PowerManager.WakeLock wakeLock;
    @Nullable
    private WifiManager.WifiLock wifiLock;

    private final Runnable micPoll = new Runnable() {
        @Override
        public void run() {
            micPollScheduled = false;
            if (!foregrounded || micTyped) return;
            if (hasMicPermission()) {
                enterForeground();
                return;
            }
            scheduleMicPoll();
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        // Post the notification at the earliest lifecycle point: create and
        // start-args are two separate main-thread messages and the
        // startForeground() deadline runs through the gap (the same reasoning
        // as MeshForegroundService).
        live = this;
        stopping = false;
        enterForeground();
        acquireWakeLock();
        acquireWifiLock();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_HANGUP.equals(intent.getAction())) {
            // Ask the web layer to leave; it then calls stop() back through the
            // plugin, which is what actually tears this service down. Stopping
            // here instead would drop the notification while the room is still
            // connected — the one state worse than having no notification.
            ArmadaCallPlugin.notifyHangup();
            return START_NOT_STICKY;
        }
        if (intent != null && ACTION_TOGGLE_MUTE.equals(intent.getAction())) {
            ArmadaCallPlugin.notifyToggleMute();
            return START_NOT_STICKY;
        }
        if (intent != null) {
            stopping = false;
            String t = intent.getStringExtra(EXTRA_TITLE);
            String s = intent.getStringExtra(EXTRA_TEXT);
            if (t != null && !t.isEmpty()) title = t;
            text = s != null ? s : "";
            String i = intent.getStringExtra(EXTRA_ICON);
            if (i == null) i = "";
            if (!i.equals(iconSource)) {
                iconSource = i;
                icon = decodeDataUrl(i);
            }
        }
        // Idempotent: re-posts the notification with the current labels, and
        // re-evaluates the service type in case the mic was granted since.
        enterForeground();
        // Not sticky: the call is owned by the WebView and cannot survive
        // process death, so a system-initiated restart would post an "in a
        // call" notification for a call that no longer exists.
        return START_NOT_STICKY;
    }

    /**
     * Enter (or re-enter) the foreground with the notification and the widest
     * service type currently permitted.
     *
     * {@code mediaPlayback} is the floor — it needs no runtime permission and
     * is honest about what an un-unmuted call is doing (playing everyone else's
     * audio) — and {@code microphone} is added whenever RECORD_AUDIO is
     * granted. Re-calling startForeground() with the wider mask is how a
     * running service widens its type; it can be refused from the background,
     * which is why the throw is caught and the existing (narrower) foreground
     * state simply left in place.
     */
    private void enterForeground() {
        boolean mic = hasMicPermission();
        // Unguarded by SDK_INT, unlike the notification service's specialUse:
        // both of these constants exist since API 29, ServiceCompat ignores the
        // type below that, and passing 0 on API 29-33 would mean "no type" —
        // which is precisely where the backgrounded-mic restriction that this
        // service exists to satisfy first applies.
        int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
        if (mic) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        try {
            ServiceCompat.startForeground(this, NOTIF_ID, buildNotification(mic), type);
            foregrounded = true;
            micTyped = mic;
        } catch (Exception e) {
            // startForeground() is refusable in its own right: API 31+ throws
            // ForegroundServiceStartNotAllowedException from a background
            // state, and API 34+ throws SecurityException when a declared
            // type's permission is missing. Uncaught out of onCreate either
            // takes the process down mid-call, which is exactly the failure
            // this service exists to prevent.
            Log.w(TAG, "Could not enter the foreground for the call notification", e);
            if (!foregrounded) {
                stopSelf();
                return;
            }
            refreshNotification();
        }
        if (!micTyped) scheduleMicPoll();
    }

    /** Not startForeground(): re-asking for the microphone type from the background can be refused. */
    private void refreshNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        try {
            nm.notify(NOTIF_ID, buildNotification(micTyped));
        } catch (SecurityException | IllegalArgumentException e) {
            Log.w(TAG, "Could not refresh the call notification", e);
        }
    }

    private void scheduleMicPoll() {
        if (micPollScheduled) return;
        micPollScheduled = true;
        handler.postDelayed(micPoll, MIC_POLL_MS);
    }

    private boolean hasMicPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * A partial wake lock for the duration of the call. The foreground service
     * keeps the process off the cached/frozen list but does NOT keep the CPU
     * out of suspend: with the screen off, Doze can idle the device out from
     * under a call the user is still listening to. Released in onDestroy, and
     * the service's own lifetime is bounded by the call's.
     */
    private void acquireWakeLock() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            PowerManager.WakeLock lock =
                    pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "armada:call");
            lock.setReferenceCounted(false);
            lock.acquire();
            wakeLock = lock;
        } catch (Exception e) {
            Log.w(TAG, "Could not acquire the call wake lock", e);
        }
    }

    private void releaseWakeLock() {
        PowerManager.WakeLock lock = wakeLock;
        wakeLock = null;
        if (lock == null) return;
        try {
            if (lock.isHeld()) lock.release();
        } catch (Exception e) {
            Log.w(TAG, "Could not release the call wake lock", e);
        }
    }

    /** Keeps Wi-Fi out of power save while the screen is off. */
    @SuppressWarnings("deprecation")
    private void acquireWifiLock() {
        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm == null) return;
            WifiManager.WifiLock lock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "armada:call");
            lock.setReferenceCounted(false);
            lock.acquire();
            wifiLock = lock;
        } catch (Exception e) {
            Log.w(TAG, "Could not acquire the call Wi-Fi lock", e);
        }
    }

    private void releaseWifiLock() {
        WifiManager.WifiLock lock = wifiLock;
        wifiLock = null;
        if (lock == null) return;
        try {
            if (lock.isHeld()) lock.release();
        } catch (Exception e) {
            Log.w(TAG, "Could not release the call Wi-Fi lock", e);
        }
    }

    private Notification buildNotification(boolean micForeground) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Ongoing calls", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shows a persistent notification while you are in a voice call.");
            ch.setShowBadge(false);
            ch.setSound(null, null);
            ch.enableVibration(false);
            nm.createNotificationChannel(ch);
        }
        // CallStyle is only accepted from a foreground service (or with a full-screen intent).
        Person room = new Person.Builder()
                .setName(title)
                .setIcon(icon != null
                        ? IconCompat.createWithBitmap(icon)
                        : IconCompat.createWithResource(this, R.mipmap.ic_launcher_round))
                .setImportant(true)
                .build();
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_armada)
                .setStyle(NotificationCompat.CallStyle.forOngoingCall(room, hangupIntent()))
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setOngoing(true)
                .setSilent(true)
                .setWhen(startedAt)
                .setShowWhen(true)
                .setUsesChronometer(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setColor(ContextCompat.getColor(this, R.color.colorAccent))
                .setContentIntent(openAppIntent());
        if (!text.isEmpty()) b.setContentText(text);
        Boolean muted = micMuted;
        if (muted != null) {
            b.addAction(new NotificationCompat.Action.Builder(
                    muted ? R.drawable.ic_call_mic_off : R.drawable.ic_call_mic,
                    muted ? "Unmute" : "Mute",
                    toggleMuteIntent(micForeground)).build());
        }
        return b.build();
    }

    @Nullable
    private static Bitmap decodeDataUrl(String url) {
        int comma = url.indexOf(',');
        if (!url.startsWith("data:image/") || comma < 0 || !url.substring(0, comma).endsWith(";base64")) {
            return null;
        }
        try {
            byte[] bytes = Base64.decode(url.substring(comma + 1), Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /**
     * Tap target: plain resume, with no ACTION_VIEW deep link. The call's own
     * channel is wherever the user left it, and MainActivity treats a
     * data-less intent as "open the app" and restores the previous screen —
     * which is the right destination, and skips the deep-link gate.
     */
    private PendingIntent openAppIntent() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
                this, NOTIF_ID, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * Toggles in place only with a mic track and the microphone type: a first unmute
     * needs getUserMedia, and background capture without the type is silence.
     */
    private PendingIntent toggleMuteIntent(boolean micForeground) {
        if (micPublished && micForeground) {
            Intent intent = new Intent(this, CallForegroundService.class);
            intent.setAction(ACTION_TOGGLE_MUTE);
            intent.setData(Uri.parse("armada-call:mute"));
            return PendingIntent.getService(
                    this, NOTIF_ID, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        }
        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction(ACTION_TOGGLE_MUTE);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
                this, NOTIF_ID, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Hang-up action: delivered back to this service as ACTION_HANGUP. */
    private PendingIntent hangupIntent() {
        Intent intent = new Intent(this, CallForegroundService.class);
        intent.setAction(ACTION_HANGUP);
        // Extras don't affect PendingIntent identity, but a data URI does; a
        // stable one here keeps this distinct from the update starts above.
        intent.setData(Uri.parse("armada-call:hangup"));
        return PendingIntent.getService(
                this, NOTIF_ID, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @Override
    public void onDestroy() {
        if (live == this) live = null;
        handler.removeCallbacks(micPoll);
        micPollScheduled = false;
        releaseWakeLock();
        releaseWifiLock();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
