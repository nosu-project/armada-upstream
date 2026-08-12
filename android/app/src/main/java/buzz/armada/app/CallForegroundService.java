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
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

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
    /** The notification's "Leave" button. */
    static final String ACTION_HANGUP = "buzz.armada.app.action.CALL_HANGUP";

    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";

    /**
     * How often to re-check RECORD_AUDIO while it is still ungranted, so the
     * {@code microphone} type can be added the moment it is. Calls are joined
     * MUTED (VoiceRoomShell passes {@code audio={false}}), so on a first-ever
     * call the permission does not exist yet when this service starts, and the
     * user may unmute at any point afterwards. A checkSelfPermission every few
     * seconds costs nothing and the poll stops for good on the first grant.
     */
    private static final long MIC_POLL_MS = 5000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean foregrounded = false;
    /** Whether the microphone type is already part of our foreground state. */
    private boolean micTyped = false;
    private boolean micPollScheduled = false;
    private String title = "Voice call";
    private String text = "";

    @Nullable
    private PowerManager.WakeLock wakeLock;

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
        enterForeground();
        acquireWakeLock();
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
        if (intent != null) {
            String t = intent.getStringExtra(EXTRA_TITLE);
            String s = intent.getStringExtra(EXTRA_TEXT);
            if (t != null && !t.isEmpty()) title = t;
            text = s != null ? s : "";
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
            ServiceCompat.startForeground(this, NOTIF_ID, buildNotification(), type);
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
        }
        if (!micTyped) scheduleMicPoll();
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

    private Notification buildNotification() {
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
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(title)
                .setSmallIcon(R.drawable.ic_stat_armada)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setOngoing(true)
                .setSilent(true)
                .setShowWhen(false)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                // Colorized applies only to an ongoing foreground-service
                // notification, which is exactly what this is: it gives the
                // call the full-width accent card that reads at a glance in a
                // crowded shade.
                .setColor(ContextCompat.getColor(this, R.color.colorAccent))
                .setColorized(true)
                .setContentIntent(openAppIntent())
                .addAction(new NotificationCompat.Action.Builder(
                        R.drawable.ic_stat_armada, "Leave", hangupIntent()).build());
        if (!text.isEmpty()) b.setContentText(text);
        return b.build();
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

    /** "Leave" action: delivered back to this service as ACTION_HANGUP. */
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
        handler.removeCallbacks(micPoll);
        micPollScheduled = false;
        releaseWakeLock();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
