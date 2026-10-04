package buzz.armada.app;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/**
 * NIP-55 requests (sign, NIP-04/44 encrypt and decrypt) to a signer app, safe
 * to issue concurrently. The content resolver answers what the user chose to
 * remember; everything else opens the signer, and EACH request gets its own
 * activity-result callback, matched back by `id` (Capacitor's
 * startActivityForResult keeps only one pending call per plugin).
 *
 * Amber's approval screen is singleTask: the request that opens it (the
 * "leader") receives the answer for every request merged into that screen
 * (`results`, a JSON array keyed by id), while each request merged in after it
 * gets an immediate cancel and stays pending until the leader's answer lands.
 */
@CapacitorPlugin(name = "ArmadaSigner")
public class ArmadaSignerPlugin extends Plugin {

    private static final String TAG = "ArmadaSigner";

    /** Re-sends of a request the signer dropped unseen, before it is reported unanswered. */
    private static final int MAX_RELAUNCHES = 2;

    // Main-thread state.
    private final Map<String, PluginCall> pending = new HashMap<>();
    private final Map<String, Intent> intents = new HashMap<>();
    private final Map<String, Integer> relaunches = new HashMap<>();
    private String leader;
    private final Set<String> followers = new LinkedHashSet<>();
    /** Amber's rate-limit bucket per request, for launches that open a new screen. */
    private final Map<String, String> paceKeys = new HashMap<>();
    private final SignerLaunchPacer pacer = new SignerLaunchPacer();
    private final Handler handler = new Handler(Looper.getMainLooper());

    @PluginMethod
    public void request(PluginCall call) {
        String pkg = call.getString("packageName");
        String type = call.getString("type");
        String payload = call.getString("payload");
        String id = call.getString("id");
        String currentUser = call.getString("currentUser");
        String pubkey = call.getString("pubkey", "");
        if (pkg == null || type == null || payload == null || id == null || currentUser == null) {
            call.reject("Missing parameters", "FAILED");
            return;
        }
        String resolverType = resolverType(type);
        if (resolverType == null) {
            call.reject("Unsupported request type " + type, "FAILED");
            return;
        }

        // Runs on the plugin thread: a remembered permission answers here, without UI.
        try {
            String[] remembered = queryResolver(pkg, resolverType, type, payload, pubkey, currentUser);
            if (remembered != null) {
                if (remembered[0] == null) {
                    call.reject("Rejected by signer", "REJECTED");
                } else {
                    call.resolve(answer(remembered[0], remembered[1]));
                }
                return;
            }
        } catch (Exception e) {
            Log.w(TAG, "content resolver query failed; falling back to the signer app", e);
        }

        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:" + payload));
        intent.setPackage(pkg);
        intent.putExtra("type", type);
        intent.putExtra("id", id);
        intent.putExtra("current_user", currentUser);
        if (!pubkey.isEmpty()) intent.putExtra("pubkey", pubkey);
        String paceKey = SignerLaunchPacer.keyOf(type, payload);
        getActivity().runOnUiThread(() -> launch(id, intent, call, paceKey));
    }

    private void launch(String id, Intent intent, PluginCall call, String paceKey) {
        if (pending.containsKey(id)) {
            call.reject("Duplicate request id", "FAILED");
            return;
        }
        pending.put(id, call);
        intents.put(id, intent);
        paceKeys.put(id, paceKey);
        start(id, intent);
    }

    private void start(String id, Intent intent) {
        if (leader == null) {
            // A new screen counts against Amber's limit; one merged into an open screen doesn't.
            long wait = pacer.reserve(paceKeys.get(id), System.currentTimeMillis());
            if (wait > 0) {
                Log.i(TAG, "pacing signer launch " + id + " by " + wait + "ms");
                handler.postDelayed(() -> {
                    if (pending.containsKey(id)) start(id, intent);
                }, wait);
                return;
            }
            leader = id;
        } else {
            followers.add(id);
        }
        final ActivityResultLauncher<Intent>[] holder = new ActivityResultLauncher[1];
        holder[0] = getActivity().getActivityResultRegistry().register(
                "armada-nip55-" + id,
                new ActivityResultContracts.StartActivityForResult(),
                (ActivityResult result) -> {
                    holder[0].unregister();
                    onResult(id, result);
                });
        try {
            holder[0].launch(intent);
        } catch (Exception e) {
            holder[0].unregister();
            settle(id, null, "Could not open the signer app", "FAILED");
            endSession(id, false);
        }
    }

    private void onResult(String id, ActivityResult activityResult) {
        Intent data = activityResult.getData();
        boolean answered = false;
        if (activityResult.getResultCode() == Activity.RESULT_OK && data != null) {
            String batch = data.getStringExtra("results");
            if (batch != null) {
                try {
                    JSONArray results = new JSONArray(batch);
                    for (int i = 0; i < results.length(); i++) {
                        JSONObject r = results.getJSONObject(i);
                        String rid = r.optString("id", "");
                        if (rid.isEmpty()) continue;
                        if (r.optBoolean("rejected", false)) {
                            settle(rid, null, "Rejected by signer", "REJECTED");
                        } else {
                            String value = r.isNull("result") ? r.optString("signature", null) : r.optString("result", null);
                            settle(rid, answer(value, null), null, null);
                        }
                        answered = true;
                    }
                } catch (Exception e) {
                    Log.w(TAG, "unparseable batch result", e);
                }
            } else {
                String rid = data.getStringExtra("id");
                if (rid == null || rid.isEmpty()) rid = id;
                if (data.getBooleanExtra("rejected", false)) {
                    settle(rid, null, "Rejected by signer", "REJECTED");
                } else {
                    String value = data.getStringExtra("result");
                    if (value == null) value = data.getStringExtra("signature");
                    settle(rid, answer(value, data.getStringExtra("event")), null, null);
                }
                answered = true;
            }
        }

        if (id.equals(leader)) {
            endSession(id, answered);
        } else if (!answered && !(followers.contains(id) && leader != null)) {
            // Not merged into an open screen (e.g. the signer refused to open): settle it now.
            followers.remove(id);
            settle(id, null, "Signer closed without answering", "CANCELLED");
        }
        // A follower cancelled on launch waits for its leader's answer.
    }

    /**
     * The leader's screen is gone. Dismissed (no answer): everything merged into
     * it is cancelled. Answered: a request merged in while a single-request
     * screen was closing was dropped unseen (Amber discards it in onDestroy), so
     * it is sent again as a new request rather than reported unanswered.
     */
    private void endSession(String id, boolean answered) {
        if (!id.equals(leader)) return;
        settle(id, null, "Signer closed without answering", "CANCELLED");
        java.util.List<String> dropped = new java.util.ArrayList<>(followers);
        followers.clear();
        leader = null;
        for (String f : dropped) {
            int tries = relaunches.getOrDefault(f, 0);
            Intent intent = intents.get(f);
            if (answered && intent != null && pending.containsKey(f) && tries < MAX_RELAUNCHES) {
                relaunches.put(f, tries + 1);
                start(f, intent);
            } else {
                settle(f, null, "Signer closed without answering", "CANCELLED");
            }
        }
    }

    /** Resolve (answer != null) or reject a pending call; a no-op once settled. */
    private void settle(String id, JSObject answer, String message, String code) {
        PluginCall call = pending.remove(id);
        if (call == null) return;
        followers.remove(id);
        intents.remove(id);
        relaunches.remove(id);
        paceKeys.remove(id);
        if (answer != null && answer.getString("result") != null) call.resolve(answer);
        else if (answer != null) call.reject("Signer returned no result", "FAILED");
        else call.reject(message, code);
    }

    private static JSObject answer(String result, String event) {
        JSObject ret = new JSObject();
        ret.put("result", result);
        if (event != null) ret.put("event", event);
        return ret;
    }

    private static String resolverType(String type) {
        switch (type) {
            case "sign_event": return "SIGN_EVENT";
            case "nip04_encrypt": return "NIP04_ENCRYPT";
            case "nip04_decrypt": return "NIP04_DECRYPT";
            case "nip44_encrypt": return "NIP44_ENCRYPT";
            case "nip44_decrypt": return "NIP44_DECRYPT";
            default: return null;
        }
    }

    /**
     * {result, event} from a remembered permission, {null, null} for an explicit
     * rejection, or null when the signer needs to ask (or the provider is gone).
     */
    private String[] queryResolver(String pkg, String resolverType, String type, String payload, String pubkey, String currentUser) {
        boolean sign = "sign_event".equals(type);
        ContentResolver resolver = getContext().getContentResolver();
        Uri uri = Uri.parse("content://" + pkg + "." + resolverType);
        String[] args = sign ? new String[] { payload, "", currentUser } : new String[] { payload, pubkey, currentUser };
        try (Cursor cursor = resolver.query(uri, args, sign ? "1" : null, null, null)) {
            if (cursor == null || !cursor.moveToFirst()) return null;
            int rejected = cursor.getColumnIndex("rejected");
            if (rejected >= 0) {
                String v = cursor.getString(rejected);
                if ("1".equals(v) || "true".equalsIgnoreCase(v)) return new String[] { null, null };
            }
            int resultIdx = cursor.getColumnIndex("result");
            if (resultIdx < 0) return null;
            int eventIdx = cursor.getColumnIndex("event");
            return new String[] { cursor.getString(resultIdx), eventIdx >= 0 ? cursor.getString(eventIdx) : null };
        }
    }
}
