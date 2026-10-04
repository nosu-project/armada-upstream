type AudioSessionType = "auto" | "playback" | "transient" | "transient-solo" | "ambient" | "play-and-record";

/** WebKit's Audio Session API (Safari 16.4+); absent from lib.dom. */
interface AudioSessionNavigator {
  audioSession?: { type: AudioSessionType };
}

/**
 * Hold a screen wake lock for as long as the call lasts. The browser drops the
 * lock whenever the page is hidden, so it is re-requested on every return.
 */
function holdScreenWakeLock(): () => void {
  const wakeLock = typeof navigator !== "undefined" ? navigator.wakeLock : undefined;
  if (!wakeLock) return () => {};
  let sentinel: WakeLockSentinel | null = null;
  let pending = false;
  let stopped = false;

  const acquire = () => {
    if (stopped || pending || (sentinel && !sentinel.released) || document.visibilityState !== "visible") return;
    pending = true;
    wakeLock.request("screen").then(
      (s) => {
        pending = false;
        if (stopped) void s.release().catch(() => {});
        else sentinel = s;
      },
      () => {
        pending = false;
      },
    );
  };

  document.addEventListener("visibilitychange", acquire);
  acquire();
  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", acquire);
    void sentinel?.release().catch(() => {});
    sentinel = null;
  };
}

/**
 * Declare the page a call to WebKit. With `webAudioMix` all remote audio is Web
 * Audio, which WebKit otherwise files as `ambient` while the mic is off:
 * silenced by the silent switch and stopped when the screen locks.
 * `play-and-record` (not `playback`) so a later mic capture isn't refused.
 */
function holdCallAudioSession(): () => void {
  const session = typeof navigator !== "undefined" ? (navigator as AudioSessionNavigator).audioSession : undefined;
  if (!session) return () => {};
  const previous = session.type;
  try {
    session.type = "play-and-record";
  } catch { /* unsupported type */ }
  return () => {
    try {
      session.type = previous;
    } catch { /* ignore */ }
  };
}

/** Keep a call alive on mobile web: screen on, and audio that survives a lock (iOS). */
export function keepCallAwake(): () => void {
  const releaseWakeLock = holdScreenWakeLock();
  const releaseSession = holdCallAudioSession();
  return () => {
    releaseWakeLock();
    releaseSession();
  };
}
