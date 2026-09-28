/**
 * Send-on-Enter preference (AppConfig.sendOnEnter), stored and synced per device
 * CLASS since physical and touch keyboards expect opposite behavior. Unset = auto.
 */
export interface SendOnEnterPref {
  /** Devices without a hover pointer (phones, tablets). Auto default: newline. */
  touch?: boolean;
  /** Devices with a physical keyboard. Auto default: send. */
  desktop?: boolean;
}

/** Unset means auto: send on a physical keyboard, newline on touch. */
export function sendsOnEnter(pref: SendOnEnterPref | undefined, isTouch: boolean): boolean {
  return pref?.[isTouch ? "touch" : "desktop"] ?? !isTouch;
}
