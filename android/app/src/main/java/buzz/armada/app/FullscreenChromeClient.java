package buzz.armada.app;

import android.graphics.Color;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;

/**
 * Capacitor's chrome client, plus HTML fullscreen.
 *
 * BridgeWebChromeClient answers onShowCustomView by calling
 * onCustomViewHidden() straight away, so every element fullscreen request —
 * the YouTube, Streamable and Mini App fullscreen buttons — is cancelled the
 * moment it is made. This puts the view the WebView hands over on top of the
 * activity with the system bars hidden, and takes it down again when the page
 * exits fullscreen or the user presses back.
 */
public class FullscreenChromeClient extends BridgeWebChromeClient {
    private final AppCompatActivity activity;
    private View customView;
    private CustomViewCallback customViewCallback;

    // Back exits fullscreen before it reaches the app's own back handling.
    // Registered last, so it wins while enabled; disabled otherwise.
    private final OnBackPressedCallback exitOnBack = new OnBackPressedCallback(false) {
        @Override
        public void handleOnBackPressed() {
            exitFullscreen();
        }
    };

    public FullscreenChromeClient(Bridge bridge) {
        super(bridge);
        this.activity = bridge.getActivity();
        activity.getOnBackPressedDispatcher().addCallback(activity, exitOnBack);
    }

    @Override
    public void onShowCustomView(View view, CustomViewCallback callback) {
        if (customView != null) {
            callback.onCustomViewHidden();
            return;
        }
        customView = view;
        customViewCallback = callback;
        view.setBackgroundColor(Color.BLACK);
        ViewGroup decor = (ViewGroup) activity.getWindow().getDecorView();
        decor.addView(view, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        WindowInsetsControllerCompat bars =
                WindowCompat.getInsetsController(activity.getWindow(), decor);
        bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        bars.hide(WindowInsetsCompat.Type.systemBars());
        exitOnBack.setEnabled(true);
    }

    @Override
    public void onHideCustomView() {
        View view = customView;
        if (view == null) return;
        customView = null;
        exitOnBack.setEnabled(false);
        ViewGroup decor = (ViewGroup) activity.getWindow().getDecorView();
        decor.removeView(view);
        WindowCompat.getInsetsController(activity.getWindow(), decor)
                .show(WindowInsetsCompat.Type.systemBars());
        CustomViewCallback callback = customViewCallback;
        customViewCallback = null;
        if (callback != null) callback.onCustomViewHidden();
    }

    private void exitFullscreen() {
        // Tell the page first so it leaves fullscreen state; the WebView then
        // calls onHideCustomView, and the direct call covers one that doesn't.
        CustomViewCallback callback = customViewCallback;
        customViewCallback = null;
        if (callback != null) callback.onCustomViewHidden();
        onHideCustomView();
    }
}
