package buzz.armada.app;

import android.annotation.SuppressLint;
import android.content.Context;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.PowerManager;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.annotation.RequiresApi;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * The call's output route, chosen natively (Android 12+): the system's
 * communication devices, applied with setCommunicationDevice. Chromium picks a
 * device of its own on mode changes and device plugs, so a user's choice is
 * re-applied whenever the system reports a switch away from it while it is
 * still available. The earpiece holds a proximity wake lock, as a phone call
 * does. Live only between begin() and end(), which also drops the choice.
 */
@RequiresApi(Build.VERSION_CODES.S)
final class CallRouteSelector {
    private static final String TAG = "CallRouteSelector";

    interface Listener {
        void onRoutesChanged(JSObject snapshot);
    }

    private final AudioManager audioManager;
    private final Listener listener;
    private final Context context;
    private boolean active = false;
    /** The user's pick for this call, by device id; null when the system chooses. */
    @Nullable
    private Integer requested;
    @Nullable
    private PowerManager.WakeLock proximityLock;

    private final AudioDeviceCallback deviceCallback = new AudioDeviceCallback() {
        @Override
        public void onAudioDevicesAdded(AudioDeviceInfo[] added) {
            publish();
        }

        @Override
        public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
            if (requested != null && find(requested) == null) requested = null;
            publish();
        }
    };

    private final AudioManager.OnCommunicationDeviceChangedListener deviceChanged = device -> {
        reassert(device);
        holdProximity(device != null && device.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE);
        publish();
    };

    CallRouteSelector(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.audioManager = (AudioManager) this.context.getSystemService(Context.AUDIO_SERVICE);
        this.listener = listener;
    }

    void begin() {
        if (active || audioManager == null) return;
        active = true;
        try {
            audioManager.registerAudioDeviceCallback(deviceCallback, null);
            audioManager.addOnCommunicationDeviceChangedListener(
                    ContextCompat.getMainExecutor(context), deviceChanged);
        } catch (Exception e) {
            Log.w(TAG, "Could not watch call routes", e);
        }
    }

    void end() {
        if (!active) return;
        active = false;
        try {
            audioManager.removeOnCommunicationDeviceChangedListener(deviceChanged);
            audioManager.unregisterAudioDeviceCallback(deviceCallback);
            // Only a route this class set is cleared: Chromium restores its own.
            if (requested != null) audioManager.clearCommunicationDevice();
        } catch (Exception e) {
            Log.w(TAG, "Could not release call routes", e);
        }
        requested = null;
        holdProximity(false);
    }

    /** Apply the device `id` as the call's route; false if it is gone or refused. */
    boolean select(int id) {
        if (!active || audioManager == null) return false;
        AudioDeviceInfo device = find(id);
        if (device == null) return false;
        boolean ok;
        try {
            ok = audioManager.setCommunicationDevice(device);
        } catch (Exception e) {
            Log.w(TAG, "Could not set the call route", e);
            ok = false;
        }
        if (ok) {
            requested = id;
            holdProximity(device.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE);
        }
        return ok;
    }

    JSObject snapshot() {
        JSObject out = new JSObject();
        out.put("supported", true);
        JSArray routes = new JSArray();
        if (audioManager != null) {
            List<AudioDeviceInfo> devices = new ArrayList<>();
            try {
                for (AudioDeviceInfo d : audioManager.getAvailableCommunicationDevices()) {
                    if (typeOf(d) != null) devices.add(d);
                }
            } catch (Exception e) {
                Log.w(TAG, "Could not list call routes", e);
            }
            devices.sort(Comparator.comparingInt(CallRouteSelector::rank));
            for (AudioDeviceInfo d : devices) {
                JSObject r = new JSObject();
                r.put("id", d.getId());
                r.put("type", typeOf(d));
                r.put("name", builtIn(d) ? "" : String.valueOf(d.getProductName()));
                routes.put(r);
            }
            AudioDeviceInfo current = null;
            try {
                current = audioManager.getCommunicationDevice();
            } catch (Exception ignored) {
            }
            if (current != null) out.put("active", current.getId());
            else out.put("active", JSObject.NULL);
        } else {
            out.put("active", JSObject.NULL);
        }
        out.put("routes", routes);
        return out;
    }

    private void reassert(@Nullable AudioDeviceInfo now) {
        Integer want = requested;
        if (want == null || now == null || now.getId() == want) return;
        AudioDeviceInfo device = find(want);
        if (device == null) {
            requested = null;
            return;
        }
        try {
            if (!audioManager.setCommunicationDevice(device)) requested = null;
        } catch (Exception e) {
            requested = null;
        }
    }

    @Nullable
    private AudioDeviceInfo find(int id) {
        try {
            for (AudioDeviceInfo d : audioManager.getAvailableCommunicationDevices()) {
                if (d.getId() == id) return d;
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private void publish() {
        if (!active) return;
        try {
            listener.onRoutesChanged(snapshot());
        } catch (Exception e) {
            Log.w(TAG, "Could not publish call routes", e);
        }
    }

    @SuppressLint("WakelockTimeout")
    private void holdProximity(boolean hold) {
        try {
            if (hold) {
                if (proximityLock == null) {
                    PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
                    if (pm == null || !pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return;
                    proximityLock = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "armada:call-earpiece");
                    proximityLock.setReferenceCounted(false);
                }
                if (!proximityLock.isHeld()) proximityLock.acquire();
            } else if (proximityLock != null && proximityLock.isHeld()) {
                proximityLock.release();
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not update the earpiece proximity lock", e);
        }
    }

    @Nullable
    private static String typeOf(AudioDeviceInfo d) {
        switch (d.getType()) {
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
            case AudioDeviceInfo.TYPE_BLE_HEADSET:
            case AudioDeviceInfo.TYPE_BLE_SPEAKER:
                return "bluetooth";
            case AudioDeviceInfo.TYPE_USB_HEADSET:
            case AudioDeviceInfo.TYPE_USB_DEVICE:
            case AudioDeviceInfo.TYPE_USB_ACCESSORY:
                return "usb";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
                return "wired";
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:
                return "speaker";
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE:
                return "earpiece";
            default:
                return null;
        }
    }

    /** Headsets first, the phone's own transducers last. */
    private static int rank(AudioDeviceInfo d) {
        String type = typeOf(d);
        if ("bluetooth".equals(type)) return 0;
        if ("usb".equals(type)) return 1;
        if ("wired".equals(type)) return 2;
        if ("speaker".equals(type)) return 3;
        return 4;
    }

    private static boolean builtIn(AudioDeviceInfo d) {
        int t = d.getType();
        return t == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER || t == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
    }
}
