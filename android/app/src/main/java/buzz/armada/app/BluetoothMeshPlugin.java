package buzz.armada.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import androidx.annotation.Nullable;

import com.bitchat.android.mesh.BluetoothMeshDelegate;
import com.bitchat.android.mesh.BluetoothMeshService;
import com.bitchat.android.mesh.PeerInfo;
import com.bitchat.android.model.BitchatMessage;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Capacitor bridge over the vendored bitchat Bluetooth mesh
 * ({@link BluetoothMeshService}, package {@code com.bitchat.android.*}).
 *
 * The web layer (useMeshTransport) calls:
 *   - setNickname({ nickname })  → flows the Armada display name into the mesh
 *                                  announce (stored in bitchat_prefs/"nickname",
 *                                  read by NicknameProvider/DataManager).
 *   - start()                    → request BLE perms, start foreground service,
 *                                  start the mesh.
 *   - stop()                     → stop the mesh + foreground service.
 *   - sendMessage({ content })   → public (broadcast) mesh message.
 *   - getPeers()                 → current peerID→nickname map.
 *
 * Events emitted to JS:
 *   - "message"  { id, sender, content, timestamp, senderPeerID, channel, isPrivate }
 *   - "peers"    { peers: [{ peerID, nickname }] }
 *
 * The mesh's cryptographic identity stays bitchat-native (Curve25519/Ed25519);
 * only the human-readable nickname is sourced from the Nostr profile, per design.
 */
@CapacitorPlugin(
        name = "BluetoothMesh",
        permissions = {
                @Permission(alias = "bluetooth", strings = {
                        Manifest.permission.BLUETOOTH_SCAN,
                        Manifest.permission.BLUETOOTH_ADVERTISE,
                        Manifest.permission.BLUETOOTH_CONNECT
                }),
                @Permission(alias = "location", strings = {
                        Manifest.permission.ACCESS_FINE_LOCATION
                })
        }
)
public class BluetoothMeshPlugin extends Plugin implements BluetoothMeshDelegate {

    private static final String TAG = "BluetoothMeshPlugin";

    @Nullable
    private BluetoothMeshService meshService;
    private boolean started = false;
    /** Keepalive refused because we weren't foreground; retried on next resume. */
    private boolean keepaliveDeferred = false;

    // ---- Plugin methods (called from JS) ----------------------------------

    @PluginMethod
    public void setNickname(PluginCall call) {
        String nickname = call.getString("nickname");
        if (nickname != null && !nickname.isEmpty()) {
            SharedPreferences prefs = getContext()
                    .getSharedPreferences("bitchat_prefs", Context.MODE_PRIVATE);
            prefs.edit().putString("nickname", nickname).apply();
            // If the mesh is already running, re-announce with the new name.
            if (meshService != null && started) {
                try { meshService.sendBroadcastAnnounce(); } catch (Exception ignored) {}
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void start(PluginCall call) {
        String[] needed = requiredBlePermissions();
        if (!hasAll(needed)) {
            requestPermissionForAlias(
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? "bluetooth" : "location",
                    call, "blePermsCallback");
            return;
        }
        doStart(call);
    }

    @PermissionCallback
    private void blePermsCallback(PluginCall call) {
        if (!hasAll(requiredBlePermissions())) {
            call.reject("Bluetooth permissions denied");
            return;
        }
        doStart(call);
    }

    private void doStart(PluginCall call) {
        try {
            if (meshService == null || !meshService.isReusable()) {
                meshService = new BluetoothMeshService(getContext().getApplicationContext());
                meshService.setDelegate(this);
            }
            if (!meshService.startServices()) {
                call.reject("Failed to start mesh: Bluetooth unavailable or permissions missing");
                return;
            }
            started = true;
            // Only now that the mesh is actually up. Starting the keepalive
            // first meant a failed startServices() immediately stopService()'d
            // it, which can destroy the service before its onCreate has run —
            // leaving a start the OS is still waiting to see answered by
            // startForeground().
            ensureKeepalive();

            JSObject ret = new JSObject();
            ret.put("peerID", meshService.getMyPeerID());
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "Failed to start mesh", e);
            String detail = e.getMessage();
            if (detail == null || detail.trim().isEmpty()) {
                detail = e.getClass().getSimpleName();
            }
            call.reject("Failed to start mesh: " + detail, e);
        }
    }

    /**
     * Best-effort foreground service so the mesh survives backgrounding.
     *
     * Deliberately startService() with NO startForegroundService() fallback.
     * startForegroundService() is a promise to call startForeground() within
     * ~10 seconds or be killed, and the only state that fallback was ever
     * reachable from is the background one where the promise is hardest to
     * keep: the service's onCreate runs on the main thread, which on a cold
     * launch is behind the whole Activity + WebView startup, and the mesh
     * auto-starts from an effect on mount rather than from a tap. startService()
     * carries no deadline and is simply refused (IllegalStateException) from the
     * background on API 26+, so the worst case is no keepalive — which is the
     * documented fallback anyway, since foreground mesh use works without it.
     */
    private void ensureKeepalive() {
        try {
            getContext().startService(new Intent(getContext(), MeshForegroundService.class));
            keepaliveDeferred = false;
        } catch (Exception e) {
            keepaliveDeferred = true;
            Log.w(TAG, "Foreground mesh service not started; continuing without background keepalive", e);
        }
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        // We are demonstrably foreground here, so a start refused earlier from
        // the background can be retried without reaching for the deadline.
        if (started && keepaliveDeferred) {
            ensureKeepalive();
        }
    }

    private void stopKeepalive() {
        keepaliveDeferred = false;
        try {
            getContext().stopService(new Intent(getContext(), MeshForegroundService.class));
        } catch (Exception e) {
            Log.w(TAG, "Failed to stop mesh keepalive service", e);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        BluetoothMeshService service = meshService;
        meshService = null;
        started = false;
        try {
            if (service != null) {
                service.setDelegate(null);
                service.stopServices();
            }
        } catch (Exception e) {
            Log.w(TAG, "stop failed", e);
        }
        stopKeepalive();
        call.resolve();
    }

    @PluginMethod
    public void sendMessage(PluginCall call) {
        String content = call.getString("content");
        if (content == null || content.isEmpty()) {
            call.reject("content required");
            return;
        }
        if (meshService == null || !started) {
            call.reject("mesh not started");
            return;
        }
        // Public broadcast message: no mentions, no channel.
        meshService.sendMessage(content, Collections.<String>emptyList(), null);
        call.resolve();
    }

    @PluginMethod
    public void sendPrivateMessage(PluginCall call) {
        String content = call.getString("content");
        String peerID = call.getString("peerID");
        String nickname = call.getString("nickname");
        String messageID = call.getString("messageID");
        if (content == null || content.isEmpty()) {
            call.reject("content required");
            return;
        }
        if (peerID == null || peerID.isEmpty()) {
            call.reject("peerID required");
            return;
        }
        if (meshService == null || !started) {
            call.reject("mesh not started");
            return;
        }
        String resolvedNickname = nickname;
        if (resolvedNickname == null || resolvedNickname.isEmpty()) {
            resolvedNickname = meshService.getPeerNicknames().get(peerID);
        }
        if (resolvedNickname == null || resolvedNickname.isEmpty()) {
            resolvedNickname = peerID;
        }
        meshService.sendPrivateMessage(content, peerID, resolvedNickname, messageID);
        call.resolve();
    }

    @PluginMethod
    public void getPeers(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("peers", peersArray());
        call.resolve(ret);
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        boolean hasBle = getContext().getPackageManager()
                .hasSystemFeature(android.content.pm.PackageManager.FEATURE_BLUETOOTH_LE);
        ret.put("available", hasBle);
        call.resolve(ret);
    }

    // ---- BluetoothMeshDelegate (called from the mesh, forwarded to JS) -----

    @Override
    public void didReceiveMessage(BitchatMessage message) {
        JSObject data = new JSObject();
        data.put("id", message.getId());
        data.put("sender", message.getSender());
        data.put("content", message.getContent());
        data.put("timestamp", message.getTimestamp() != null ? message.getTimestamp().getTime() : 0L);
        data.put("senderPeerID", message.getSenderPeerID());
        data.put("channel", message.getChannel());
        data.put("isPrivate", message.isPrivate());
        notifyListeners("message", data);
    }

    @Override
    public void didUpdatePeerList(List<String> peers) {
        JSObject data = new JSObject();
        data.put("peers", peersArray());
        notifyListeners("peers", data);
    }

    @Override
    public void didReceiveChannelLeave(String channel, String fromPeer) { }

    @Override
    public void didReceiveDeliveryAck(String messageID, String recipientPeerID) {
        JSObject data = new JSObject();
        data.put("messageID", messageID);
        data.put("peerID", recipientPeerID);
        notifyListeners("deliveryAck", data);
    }

    @Override
    public void didReceiveReadReceipt(String messageID, String recipientPeerID) {
        JSObject data = new JSObject();
        data.put("messageID", messageID);
        data.put("peerID", recipientPeerID);
        notifyListeners("readReceipt", data);
    }

    @Override
    public void didReceiveVerifyChallenge(String peerID, byte[] payload, long timestampMs) { }

    @Override
    public void didReceiveVerifyResponse(String peerID, byte[] payload, long timestampMs) { }

    @Nullable
    @Override
    public String decryptChannelMessage(byte[] encryptedContent, String channel) {
        // Password-protected channels not supported in the first cut.
        return null;
    }

    @Nullable
    @Override
    public String getNickname() {
        SharedPreferences prefs = getContext()
                .getSharedPreferences("bitchat_prefs", Context.MODE_PRIVATE);
        String n = prefs.getString("nickname", null);
        return (n != null && !n.isEmpty()) ? n : null;
    }

    @Override
    public boolean isFavorite(String peerID) {
        return false;
    }

    // ---- helpers ----------------------------------------------------------

    private JSArray peersArray() {
        JSArray arr = new JSArray();
        if (meshService != null) {
            Map<String, String> nicks = meshService.getPeerNicknames();
            for (Map.Entry<String, String> e : nicks.entrySet()) {
                JSObject p = new JSObject();
                p.put("peerID", e.getKey());
                p.put("nickname", e.getValue());
                PeerInfo info = meshService.getPeerInfo(e.getKey());
                if (info != null) {
                    p.put("isConnected", info.isConnected());
                    p.put("isDirectConnection", info.isDirectConnection());
                    p.put("isVerified", info.isVerifiedNickname());
                    p.put("lastSeen", info.getLastSeen());
                    byte[] noisePublicKey = info.getNoisePublicKey();
                    if (noisePublicKey != null) {
                        p.put("noisePublicKey", bytesToHex(noisePublicKey));
                    }
                }
                arr.put(p);
            }
        }
        return arr;
    }

    private String bytesToHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(String.format("%02x", b & 0xff));
        }
        return sb.toString();
    }

    private String[] requiredBlePermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return new String[]{
                    Manifest.permission.BLUETOOTH_SCAN,
                    Manifest.permission.BLUETOOTH_ADVERTISE,
                    Manifest.permission.BLUETOOTH_CONNECT
            };
        }
        return new String[]{ Manifest.permission.ACCESS_FINE_LOCATION };
    }

    private boolean hasAll(String[] perms) {
        for (String p : perms) {
            if (getContext().checkSelfPermission(p)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                return false;
            }
        }
        return true;
    }

    @Override
    protected void handleOnDestroy() {
        if (meshService != null && started) {
            try { meshService.stopServices(); } catch (Exception ignored) {}
            // The mesh is gone with it, so the keepalive would otherwise sit in
            // the shade advertising a mesh that is no longer running.
            stopKeepalive();
        }
        started = false;
        super.handleOnDestroy();
    }
}
