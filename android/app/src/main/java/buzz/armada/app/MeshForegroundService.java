package buzz.armada.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

/**
 * Minimal foreground service that keeps the Bluetooth mesh (bitchat) alive
 * while the app is backgrounded. The actual mesh lifecycle (BluetoothMeshService
 * start/stop) is owned by {@link BluetoothMeshPlugin}; this service exists only
 * to satisfy Android's requirement that long-running BLE advertising/scanning
 * run under a foreground service with an ongoing notification.
 */
public class MeshForegroundService extends Service {
    private static final String TAG = "MeshForegroundService";
    private static final String CHANNEL_ID = "armada_mesh";
    private static final int NOTIF_ID = 4711;

    private boolean foregrounded = false;

    @Override
    public void onCreate() {
        super.onCreate();
        // Post the foreground notification at the earliest lifecycle point:
        // service create and start-args are two separate main-thread messages,
        // and the startForeground() deadline keeps running through the gap —
        // where unrelated queued work (WebView/JS posts) can burn it.
        startForegroundCompat();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Idempotent re-post of the same notification; also covers redelivered
        // starts on an already-created service.
        startForegroundCompat();
        // Not sticky: the mesh is owned by BluetoothMeshPlugin and does not
        // survive process death, so a system-initiated restart would post an
        // "active" notification for a mesh that isn't running — and would post
        // it from a background state where startForeground() can be refused.
        return START_NOT_STICKY;
    }

    private void startForegroundCompat() {
        if (foregrounded) {
            return;
        }
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Bluetooth mesh", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Keeps the nearby Bluetooth mesh chat connected.");
            nm.createNotificationChannel(ch);
        }
        Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Mesh chat active")
                .setContentText("Connected to nearby devices over Bluetooth")
                .setSmallIcon(R.mipmap.ic_launcher)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(NOTIF_ID, n,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            } else {
                startForeground(NOTIF_ID, n);
            }
            foregrounded = true;
        } catch (Exception e) {
            // startForeground() is refusable in its own right: API 31+ throws
            // ForegroundServiceStartNotAllowedException from a background
            // state, and API 34+ throws SecurityException if the
            // connectedDevice type's Bluetooth permissions were revoked between
            // the plugin's check and here. Uncaught out of onCreate, either one
            // takes the whole process down over an optional keepalive.
            Log.w(TAG, "Could not enter the foreground; stopping the mesh keepalive", e);
            stopSelf();
        }
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
