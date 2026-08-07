package buzz.armada.app;

import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import androidx.credentials.CreateCredentialResponse;
import androidx.credentials.CreatePasswordRequest;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.exceptions.CreateCredentialCancellationException;
import androidx.credentials.exceptions.CreateCredentialException;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Saves the account's secret key to the Android Credential Manager (the system
 * "Save password?" sheet, backed by whichever provider the user has chosen), so
 * onboarding can offer a real, biometric-gated, cross-device backup instead of
 * a WebView file download that silently does nothing.
 *
 * The web layer stores the nsec as a password credential keyed by the npub. The
 * OS sheet is provider- and lock-screen-gated; we never see the biometric. This
 * mirrors the web's `navigator.credentials.store(PasswordCredential)` path.
 *
 * ANDROID 14 (API 34) AND UP ONLY, by choice. androidx.credentials routes to
 * the platform CredentialManager system service, which exists only from 34.
 * Below that it needs a provider implementation on the classpath, and the one
 * Google ships (credentials-play-services-auth) is the root of the entire
 * proprietary Play Services auth subtree, which Armada does not bundle. So on
 * API 24-33 the create call fails with
 * CreateCredentialProviderConfigurationException. That is a routine, expected
 * outcome here, not a bug to fix by adding the dependency back: it lands in
 * onError below as `saved=false, cancelled=false`, and the web layer falls back
 * to writing the key to a file (see `backUpNsec` in credentialManager.ts).
 *
 * `saveCredential` never rejects for an expected outcome: it resolves
 * `{ saved, cancelled }` so the web layer can decide whether to proceed
 * (`saved`), stay put (`cancelled` — the user dismissed the sheet), or fall
 * back to exporting the key another way (`saved=false, cancelled=false` — no
 * provider available, which is every device below API 34).
 */
@CapacitorPlugin(name = "ArmadaCredential")
public class ArmadaCredentialPlugin extends Plugin {

    @PluginMethod
    public void saveCredential(PluginCall call) {
        String id = call.getString("id");
        String password = call.getString("password");
        if (id == null || password == null) {
            call.reject("id and password are required");
            return;
        }

        final Context activity = getActivity();
        if (activity == null) {
            resolveResult(call, false, false, "no-activity");
            return;
        }

        final CredentialManager credentialManager = CredentialManager.create(activity);
        final CreatePasswordRequest request = new CreatePasswordRequest(id, password);

        // createCredentialAsync launches system UI; drive it from the UI thread.
        getActivity().runOnUiThread(() ->
            credentialManager.createCredentialAsync(
                activity,
                request,
                null,
                ContextCompat.getMainExecutor(activity),
                new CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException>() {
                    @Override
                    public void onResult(CreateCredentialResponse result) {
                        resolveResult(call, true, false, null);
                    }

                    @Override
                    public void onError(@NonNull CreateCredentialException e) {
                        boolean cancelled = e instanceof CreateCredentialCancellationException;
                        resolveResult(call, false, cancelled, e.getClass().getSimpleName());
                    }
                }
            )
        );
    }

    /**
     * Write a text file to the device's public Downloads folder, so onboarding
     * can save the secret key to the filesystem when the keyring isn't an
     * option. Blob downloads don't work in the Android WebView, so the web
     * layer can't do this itself.
     *
     * API 29+ uses MediaStore (no storage permission, shows up in Downloads /
     * the Files app); older devices fall back to the app's own external files
     * dir (also permission-free). Resolves `{ location }` for a confirmation
     * message, or rejects on IO failure.
     */
    @PluginMethod
    public void saveToFile(PluginCall call) {
        String filename = call.getString("filename");
        String content = call.getString("content");
        if (filename == null || content == null) {
            call.reject("filename and content are required");
            return;
        }

        final Context context = getContext();
        byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
        try {
            String location;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
                values.put(MediaStore.Downloads.MIME_TYPE, "text/plain");
                Uri item = context.getContentResolver()
                    .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (item == null) {
                    call.reject("Could not create the file");
                    return;
                }
                try (OutputStream os = context.getContentResolver().openOutputStream(item)) {
                    os.write(bytes);
                }
                location = "Downloads/" + filename;
            } else {
                File dir = context.getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS);
                File file = new File(dir, filename);
                try (FileOutputStream fos = new FileOutputStream(file)) {
                    fos.write(bytes);
                }
                location = file.getAbsolutePath();
            }
            JSObject ret = new JSObject();
            ret.put("location", location);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not write the file: " + e.getMessage());
        }
    }

    private void resolveResult(PluginCall call, boolean saved, boolean cancelled, String reason) {
        JSObject ret = new JSObject();
        ret.put("saved", saved);
        ret.put("cancelled", cancelled);
        if (reason != null) ret.put("reason", reason);
        call.resolve(ret);
    }
}
