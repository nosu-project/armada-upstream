/**
 * The send-on-Enter preference (see AppConfig.sendOnEnter). Keyed by device
 * CLASS, not by individual device: the expectation is in opposition between a
 * physical keyboard (Enter sends) and a touch keyboard (Enter is a newline, you
 * tap send), so the override is stored per class and synced. All of a user's
 * desktops share the `desktop` value and all their phones share `touch`, and
 * the two never conflict. A class left unset falls back to the auto default.
 */
export interface SendOnEnterPref {
  /** Devices without a hover pointer (phones, tablets). Auto default: newline. */
  touch?: boolean;
  /** Devices with a physical keyboard. Auto default: send. */
  desktop?: boolean;
}

/**
 * Resolve whether Enter sends on this device. Unset for the current class means
 * "auto": send on a physical keyboard, insert a newline on touch.
 */
export function sendsOnEnter(pref: SendOnEnterPref | undefined, isTouch: boolean): boolean {
  return pref?.[isTouch ? "touch" : "desktop"] ?? !isTouch;
}
