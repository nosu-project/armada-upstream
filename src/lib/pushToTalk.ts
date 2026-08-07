import { useSyncExternalStore } from "react";

import { desktop } from "@/lib/desktop";

const STORAGE_KEY = "armada:push-to-talk";
const CHANGE_EVENT = "armada:push-to-talk-change";

export interface PushToTalkBinding {
  code: string;
  label: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface PushToTalkPreferences {
  enabled: boolean;
  binding: PushToTalkBinding;
}

export interface PushToTalkStatus {
  supported: boolean;
  backend: "native" | "portal" | null;
  bindingLabel: string | null;
  reason: string | null;
}

export interface PushToTalkRuntime {
  ready: boolean;
  pressed: boolean;
  bindingLabel: string | null;
}

export const DEFAULT_PUSH_TO_TALK_BINDING: PushToTalkBinding = {
  code: "CapsLock",
  label: "Caps Lock",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
};

const DEFAULT_PREFERENCES: PushToTalkPreferences = {
  enabled: false,
  binding: DEFAULT_PUSH_TO_TALK_BINDING,
};

const DEFAULT_RUNTIME: PushToTalkRuntime = {
  ready: false,
  pressed: false,
  bindingLabel: null,
};

let cachedRaw: string | null | undefined;
let cachedPreferences = DEFAULT_PREFERENCES;
let runtime = DEFAULT_RUNTIME;
const runtimeListeners = new Set<() => void>();

function isBinding(value: unknown): value is PushToTalkBinding {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PushToTalkBinding>;
  return (
    typeof candidate.code === "string" &&
    candidate.code.length > 0 &&
    typeof candidate.label === "string" &&
    candidate.label.length > 0 &&
    [candidate.altKey, candidate.ctrlKey, candidate.metaKey, candidate.shiftKey].every(
      (flag) => typeof flag === "boolean",
    )
  );
}

function parsePreferences(raw: string | null): PushToTalkPreferences {
  if (!raw) return DEFAULT_PREFERENCES;
  try {
    const value = JSON.parse(raw) as Partial<PushToTalkPreferences>;
    if (typeof value.enabled !== "boolean" || !isBinding(value.binding)) {
      return DEFAULT_PREFERENCES;
    }
    return { enabled: value.enabled, binding: value.binding };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function getPushToTalkPreferences(): PushToTalkPreferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedPreferences = parsePreferences(raw);
  }
  return cachedPreferences;
}

export function setPushToTalkPreferences(preferences: PushToTalkPreferences): void {
  if (typeof window === "undefined") return;
  const normalized = {
    enabled: Boolean(preferences.enabled),
    binding: isBinding(preferences.binding)
      ? preferences.binding
      : DEFAULT_PUSH_TO_TALK_BINDING,
  };
  const raw = JSON.stringify(normalized);
  window.localStorage.setItem(STORAGE_KEY, raw);
  cachedRaw = raw;
  cachedPreferences = normalized;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribePushToTalkPreferences(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    cachedRaw = undefined;
    listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function usePushToTalkPreferences(): PushToTalkPreferences {
  return useSyncExternalStore(
    subscribePushToTalkPreferences,
    getPushToTalkPreferences,
    () => DEFAULT_PREFERENCES,
  );
}

const KEY_LABELS: Record<string, string> = {
  AltLeft: "Left Alt",
  AltRight: "Right Alt",
  ArrowDown: "Down Arrow",
  ArrowLeft: "Left Arrow",
  ArrowRight: "Right Arrow",
  ArrowUp: "Up Arrow",
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  CapsLock: "Caps Lock",
  ControlLeft: "Left Ctrl",
  ControlRight: "Right Ctrl",
  Equal: "=",
  MetaLeft: "Left Meta",
  MetaRight: "Right Meta",
  Minus: "-",
  NumpadAdd: "Numpad +",
  NumpadDecimal: "Numpad .",
  NumpadDivide: "Numpad /",
  NumpadEnter: "Numpad Enter",
  NumpadMultiply: "Numpad *",
  NumpadSubtract: "Numpad -",
  PageDown: "Page Down",
  PageUp: "Page Up",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  ShiftLeft: "Left Shift",
  ShiftRight: "Right Shift",
  Slash: "/",
  Space: "Space",
};

function keyLabel(code: string, fallback: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `Numpad ${code.slice(6)}`;
  return KEY_LABELS[code] || fallback || code;
}

export function bindingFromKeyboardEvent(
  event: Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
): PushToTalkBinding | null {
  if (!event.code || event.code === "Unidentified") return null;
  const triggerIsAlt = event.code === "AltLeft" || event.code === "AltRight";
  const triggerIsCtrl = event.code === "ControlLeft" || event.code === "ControlRight";
  const triggerIsMeta = event.code === "MetaLeft" || event.code === "MetaRight";
  const triggerIsShift = event.code === "ShiftLeft" || event.code === "ShiftRight";
  const modifiers = [
    event.ctrlKey && !triggerIsCtrl ? "Ctrl" : null,
    event.altKey && !triggerIsAlt ? "Alt" : null,
    event.shiftKey && !triggerIsShift ? "Shift" : null,
    event.metaKey && !triggerIsMeta ? "Meta" : null,
  ].filter((value): value is string => Boolean(value));
  const trigger = keyLabel(event.code, event.key);
  return {
    code: event.code,
    label: [...modifiers, trigger].join(" + "),
    altKey: event.altKey && !triggerIsAlt,
    ctrlKey: event.ctrlKey && !triggerIsCtrl,
    metaKey: event.metaKey && !triggerIsMeta,
    shiftKey: event.shiftKey && !triggerIsShift,
  };
}

export async function configureDesktopPushToTalk(
  binding: PushToTalkBinding | null,
): Promise<PushToTalkStatus> {
  const bridge = desktop();
  if (!bridge?.configurePushToTalk) {
    return {
      supported: false,
      backend: null,
      bindingLabel: binding?.label ?? null,
      reason: "This desktop build does not include push to talk.",
    };
  }
  try {
    return await bridge.configurePushToTalk(binding);
  } catch {
    return {
      supported: false,
      backend: null,
      bindingLabel: binding?.label ?? null,
      reason: "The global push-to-talk shortcut could not be registered.",
    };
  }
}

export async function setDesktopPushToTalkActive(active: boolean): Promise<boolean> {
  try {
    return (await desktop()?.setPushToTalkActive?.(active)) ?? false;
  } catch {
    return false;
  }
}

export async function openDesktopPushToTalkSystemSettings(): Promise<boolean> {
  try {
    return (await desktop()?.openPushToTalkSystemSettings?.()) ?? false;
  } catch {
    return false;
  }
}

export function onDesktopPushToTalkState(listener: (pressed: boolean) => void): () => void {
  try {
    return desktop()?.onPushToTalkState?.(listener) ?? (() => {});
  } catch {
    return () => {};
  }
}

export function onDesktopPushToTalkStatus(
  listener: (status: PushToTalkStatus) => void,
): () => void {
  try {
    return desktop()?.onPushToTalkStatus?.(listener) ?? (() => {});
  } catch {
    return () => {};
  }
}

export function setPushToTalkRuntime(next: PushToTalkRuntime): void {
  if (
    runtime.ready === next.ready &&
    runtime.pressed === next.pressed &&
    runtime.bindingLabel === next.bindingLabel
  ) return;
  runtime = next;
  for (const listener of runtimeListeners) listener();
}

export function usePushToTalkRuntime(): PushToTalkRuntime {
  return useSyncExternalStore(
    (listener) => {
      runtimeListeners.add(listener);
      return () => runtimeListeners.delete(listener);
    },
    () => runtime,
    () => DEFAULT_RUNTIME,
  );
}
