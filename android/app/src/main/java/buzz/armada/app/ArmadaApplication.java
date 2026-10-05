package buzz.armada.app;

import android.app.Application;
import android.os.Looper;

/**
 * Application subclass whose only job is to (re)start the background
 * notification service as early as possible on every process launch.
 *
 * The service is START_STICKY and is restarted on boot by {@link BootReceiver},
 * but between those it otherwise only starts when the WebView finishes loading
 * and the React layer calls ArmadaNotification.configure(). A fresh process
 * that starts for any other reason (a broadcast, an alarm, the system
 * resurrecting the app) would then wait for the whole WebView to come up before
 * reconnecting. Starting here — gated by NotificationRelayService.isConfigured
 * so a logged-out / notifications-off user is untouched — closes that gap, the
 * way bitchat starts its mesh service from Application.onCreate.
 *
 * The start is deferred to the main thread's first idle rather than made
 * synchronously: a startForegroundService() call here opens the 10-second
 * startForeground() deadline immediately, and on a UI launch the service's
 * onCreate then queues BEHIND the whole Activity + WebView cold start. A slow
 * device can exceed the deadline and the OS kills the app
 * (ForegroundServiceDidNotStartInTimeException). At first idle the launch work
 * has drained. BootReceiver's own direct call may win the race on a non-UI
 * launch; the instance check in startIfConfigured makes the second a no-op.
 *
 * startIfConfigured tolerates the Android 14+ background-start restriction: if
 * the process launched in the background and the OS refuses the FGS start, it
 * schedules the same short retry alarm BootReceiver uses.
 */
public class ArmadaApplication extends Application {

    @Override
    public void onCreate() {
        super.onCreate();
        Looper.myQueue().addIdleHandler(() -> {
            NotificationRelayService.startIfConfigured(this);
            return false; // one-shot
        });
    }
}
