package pub.armada.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;
import android.util.Log;

/**
 * Brings the notification foreground service back whenever it isn't already
 * running, from three triggers:
 *
 *   - a device reboot or app update (BOOT_COMPLETED / MY_PACKAGE_REPLACED);
 *   - a short one-shot retry alarm (a background FGS start can still be refused
 *     in some states, so the first attempt after boot can fail — the retry
 *     succeeds once the app is exempt from battery optimizations); and
 *   - a periodic self-healing watchdog alarm that re-arms itself while
 *     configured, so an ordinary process kill is recovered without waiting for
 *     the user to open the app.
 *
 * The service reads its full config (relays, group ids, prefs, Concord subs)
 * from SharedPreferences, so a background start works without the WebView —
 * same as a START_STICKY restart. NIP-42 AUTH challenges can't be signed until
 * the app is next opened, but non-AUTH relays stream fine.
 *
 * Gating and the actual start live in {@link NotificationRelayService}
 * (isConfigured / startIfConfigured) so boot, the watchdog, the plugin and
 * {@link ArmadaApplication} all share one path.
 */
public class BootReceiver extends BroadcastReceiver {

    private static final String TAG = "ArmadaBootReceiver";
    static final String ACTION_RETRY = "pub.armada.app.ACTION_BOOT_RETRY";
    static final String ACTION_WATCHDOG = "pub.armada.app.ACTION_WATCHDOG";
    private static final int RETRY_REQUEST_CODE = 1001;
    private static final int WATCHDOG_REQUEST_CODE = 1002;
    private static final long RETRY_DELAY_MS = 15_000;
    // Doze coalesces setAndAllowWhileIdle alarms to at most ~1 per 9-15 min, so
    // a tighter interval buys nothing. Each fire re-arms the next.
    private static final long WATCHDOG_INTERVAL_MS = 15 * 60 * 1_000;

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null) return;

        boolean known = Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                || ACTION_RETRY.equals(action)
                || ACTION_WATCHDOG.equals(action);
        if (!known) return;

        // Not configured (logged out / notifications off): do nothing, and let
        // the watchdog chain lapse — it is only re-armed on the configured path
        // below and in the service's onStartCommand.
        if (!NotificationRelayService.isConfigured(context)) {
            return;
        }

        // The retry and watchdog alarms are themselves the retry, so don't have
        // startIfConfigured schedule another one-shot retry on top of them.
        boolean allowRetry = Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action);
        NotificationRelayService.startIfConfigured(context, allowRetry);
        Log.d(TAG, "Ensured NotificationRelayService (" + action + ")");

        // Keep the self-healing chain alive while configured.
        scheduleWatchdog(context);
    }

    static void scheduleRetry(Context context) {
        schedule(context, ACTION_RETRY, RETRY_REQUEST_CODE, RETRY_DELAY_MS);
    }

    static void scheduleWatchdog(Context context) {
        schedule(context, ACTION_WATCHDOG, WATCHDOG_REQUEST_CODE, WATCHDOG_INTERVAL_MS);
    }

    static void cancelWatchdog(Context context) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = pendingIntent(
                context, ACTION_WATCHDOG, WATCHDOG_REQUEST_CODE, PendingIntent.FLAG_NO_CREATE);
        if (pi != null) am.cancel(pi);
    }

    private static void schedule(Context context, String action, int requestCode, long delayMs) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        am.setAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + delayMs,
                pendingIntent(context, action, requestCode, PendingIntent.FLAG_UPDATE_CURRENT));
    }

    private static PendingIntent pendingIntent(
            Context context, String action, int requestCode, int extraFlags) {
        Intent i = new Intent(context, BootReceiver.class).setAction(action);
        return PendingIntent.getBroadcast(
                context, requestCode, i, extraFlags | PendingIntent.FLAG_IMMUTABLE);
    }
}
