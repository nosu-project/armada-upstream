package pub.armada.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

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
    private static final String CHANNEL_ID = "armada_mesh";
    private static final int NOTIF_ID = 4711;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForegroundCompat();
        return START_STICKY;
    }

    private void startForegroundCompat() {
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, n,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
                            | ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIF_ID, n);
        }
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
