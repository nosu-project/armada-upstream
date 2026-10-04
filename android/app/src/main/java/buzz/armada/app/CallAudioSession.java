package buzz.armada.app;

import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.util.Log;
import android.view.KeyEvent;

import androidx.annotation.Nullable;

/**
 * Call audio behaviour the WebView doesn't provide, held for the whole call:
 *
 *   - Transient audio focus, so music pauses until hang-up.
 *   - A media-button session, so headset presses (including spurious ones
 *     from mic-bias changes) don't reach the music app. Swallowed rather than
 *     mapped to mute/hang-up, since a spurious press would act on the call.
 *   - Volume keys on STREAM_MUSIC: Chromium plays call audio as USAGE_MEDIA,
 *     while MODE_IN_COMMUNICATION points the keys (and overrides
 *     setVolumeControlStream) at STREAM_VOICE_CALL.
 *
 * No routing: a media-usage stream follows headsets and never hits the earpiece.
 */
final class CallAudioSession {
    private static final String TAG = "CallAudioSession";

    private final Context context;
    @Nullable
    private final AudioManager audioManager;
    @Nullable
    private AudioFocusRequest focusRequest;
    private boolean legacyFocusHeld = false;
    @Nullable
    private MediaSession mediaSession;
    private boolean active = false;
    /** Read by MainActivity's key dispatch, which has no handle on the plugin. */
    private static volatile boolean inCall = false;

    private final AudioManager.OnAudioFocusChangeListener focusListener =
            change -> Log.i(TAG, "Audio focus change: " + change);

    CallAudioSession(Context context) {
        this.context = context.getApplicationContext();
        this.audioManager = (AudioManager) this.context.getSystemService(Context.AUDIO_SERVICE);
    }

    /** Idempotent: the plugin's start() is re-called on every relabel. */
    void begin() {
        if (active) return;
        active = true;
        inCall = true;
        requestFocus();
        claimMediaButtons();
    }

    void end() {
        if (!active) return;
        active = false;
        inCall = false;
        releaseMediaButtons();
        abandonFocus();
    }

    /** Steer a volume key to the stream the call actually plays on; false to let it through. */
    static boolean handleVolumeKey(Context context, KeyEvent event) {
        if (!inCall) return false;
        int code = event.getKeyCode();
        if (code != KeyEvent.KEYCODE_VOLUME_UP && code != KeyEvent.KEYCODE_VOLUME_DOWN) return false;
        if (event.getAction() == KeyEvent.ACTION_DOWN) {
            AudioManager am = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return false;
            am.adjustStreamVolume(AudioManager.STREAM_MUSIC,
                    code == KeyEvent.KEYCODE_VOLUME_UP ? AudioManager.ADJUST_RAISE : AudioManager.ADJUST_LOWER,
                    AudioManager.FLAG_SHOW_UI);
        }
        return true;
    }

    @SuppressWarnings("deprecation")
    private void requestFocus() {
        if (audioManager == null) return;
        try {
            int result;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                // Not _EXCLUSIVE: notification sounds stay audible during a call.
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                        .setAudioAttributes(new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                .build())
                        .setOnAudioFocusChangeListener(focusListener)
                        .build();
                result = audioManager.requestAudioFocus(focusRequest);
            } else {
                result = audioManager.requestAudioFocus(
                        focusListener, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
                legacyFocusHeld = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
            }
            if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                Log.w(TAG, "Call audio focus not granted: " + result);
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not request call audio focus", e);
        }
    }

    @SuppressWarnings("deprecation")
    private void abandonFocus() {
        if (audioManager == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (focusRequest != null) audioManager.abandonAudioFocusRequest(focusRequest);
            } else if (legacyFocusHeld) {
                audioManager.abandonAudioFocus(focusListener);
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not abandon call audio focus", e);
        }
        focusRequest = null;
        legacyFocusHeld = false;
    }

    private void claimMediaButtons() {
        try {
            MediaSession session = new MediaSession(context, "ArmadaCall");
            session.setCallback(new MediaSession.Callback() {
                @Override
                public boolean onMediaButtonEvent(Intent intent) {
                    KeyEvent event = keyEventOf(intent);
                    if (event != null && event.getAction() == KeyEvent.ACTION_DOWN) {
                        Log.i(TAG, "Swallowed media button during call: " + KeyEvent.keyCodeToString(event.getKeyCode()));
                    }
                    return true;
                }
            });
            // A playing session is the one media buttons are dispatched to.
            session.setPlaybackState(new PlaybackState.Builder()
                    .setActions(PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_PLAY
                            | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_SKIP_TO_NEXT
                            | PlaybackState.ACTION_SKIP_TO_PREVIOUS)
                    .setState(PlaybackState.STATE_PLAYING, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f)
                    .build());
            session.setActive(true);
            mediaSession = session;
        } catch (Exception e) {
            Log.w(TAG, "Could not claim media buttons for the call", e);
        }
    }

    private void releaseMediaButtons() {
        MediaSession session = mediaSession;
        mediaSession = null;
        if (session == null) return;
        try {
            session.setActive(false);
            session.release();
        } catch (Exception e) {
            Log.w(TAG, "Could not release the call media session", e);
        }
    }

    @Nullable
    @SuppressWarnings("deprecation")
    private static KeyEvent keyEventOf(Intent intent) {
        if (intent == null) return null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent.class);
        }
        return intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
    }
}
