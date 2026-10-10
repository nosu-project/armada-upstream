package buzz.armada.app;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.core.content.IntentCompat;

import java.lang.ref.WeakReference;

/**
 * The incoming call's full-screen intent target, shown over the lock screen.
 * Never MainActivity: a full-screen intent fires untapped. Its own task, removed
 * when the ring ends, so nothing is left behind the keyguard. Not exported: the
 * answer/decline intents in its extras come only from the service.
 */
public class IncomingCallActivity extends Activity {
    private static final String TAG = "IncomingCall";
    static final String EXTRA_NAME = "armada_call_name";
    static final String EXTRA_RING_UNTIL_MS = "armada_call_ring_until";
    static final String EXTRA_ANSWER = "armada_call_answer";
    static final String EXTRA_DECLINE = "armada_call_decline";

    private static WeakReference<IncomingCallActivity> current = new WeakReference<>(null);

    private final Handler main = new Handler(Looper.getMainLooper());
    private String callId;

    /** The ring for {@code callId} ended (answered, declined, cancelled, timed out). */
    static void dismiss(String callId) {
        new Handler(Looper.getMainLooper()).post(() -> {
            IncomingCallActivity a = current.get();
            if (a != null && (callId == null || callId.equals(a.callId))) a.finishAndRemoveTask();
        });
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        bind(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        bind(intent);
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        if (current.get() == this) current = new WeakReference<>(null);
        super.onDestroy();
    }

    private void bind(Intent intent) {
        callId = intent.getStringExtra(NotificationRelayService.EXTRA_CALL_ID);
        long until = intent.getLongExtra(EXTRA_RING_UNTIL_MS, 0);
        long left = until - System.currentTimeMillis();
        if (callId == null || left <= 0) {
            finishAndRemoveTask();
            return;
        }
        current = new WeakReference<>(this);
        main.removeCallbacksAndMessages(null);
        main.postDelayed(this::finishAndRemoveTask, left);

        String name = intent.getStringExtra(EXTRA_NAME);
        final Intent answer = IntentCompat.getParcelableExtra(intent, EXTRA_ANSWER, Intent.class);
        final Intent decline = IntentCompat.getParcelableExtra(intent, EXTRA_DECLINE, Intent.class);
        setContentView(buildView(name != null ? name : "", () -> accept(answer), () -> decline(decline)));
    }

    private void accept(Intent answer) {
        if (answer != null) {
            try {
                startActivity(answer);
            } catch (Exception e) {
                Log.w(TAG, "answer failed", e);
            }
        }
        KeyguardManager km = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        if (km != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            km.requestDismissKeyguard(this, null);
        }
        finishAndRemoveTask();
    }

    private void decline(Intent decline) {
        if (decline != null) {
            try {
                startService(decline);
            } catch (Exception e) {
                Log.w(TAG, "decline failed", e);
            }
        }
        finishAndRemoveTask();
    }

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private LinearLayout buildView(String name, Runnable onAccept, Runnable onDecline) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setBackgroundColor(Color.parseColor("#100b15"));
        root.setPadding(dp(24), dp(120), dp(24), dp(96));

        TextView title = new TextView(this);
        title.setText(name);
        title.setTextColor(Color.WHITE);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30);
        title.setGravity(Gravity.CENTER);
        title.setMaxLines(2);
        root.addView(title);

        TextView sub = new TextView(this);
        sub.setText("Incoming call");
        sub.setTextColor(Color.parseColor("#b3ffffff"));
        sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        sub.setGravity(Gravity.CENTER);
        sub.setPadding(0, dp(8), 0, 0);
        root.addView(sub);

        LinearLayout spacer = new LinearLayout(this);
        root.addView(spacer, new LinearLayout.LayoutParams(0, 0, 1f));

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER);
        row.addView(roundButton("Decline", "#e5484d", onDecline));
        LinearLayout gap = new LinearLayout(this);
        row.addView(gap, new LinearLayout.LayoutParams(dp(72), 1));
        row.addView(roundButton("Accept", "#30a46c", onAccept));
        root.addView(row);
        return root;
    }

    private Button roundButton(String label, String color, Runnable onClick) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(Color.WHITE);
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(Color.parseColor(color));
        b.setBackground(bg);
        b.setLayoutParams(new LinearLayout.LayoutParams(dp(88), dp(88)));
        b.setOnClickListener(v -> onClick.run());
        return b;
    }
}
