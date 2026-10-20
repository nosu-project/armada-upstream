import { Capacitor } from "@capacitor/core";

/** Where a finished take goes: a folder the user picked, or the platform's downloads. */
export type RecordingDestination =
  | { kind: "folder"; handle: FileSystemDirectoryHandle }
  | { kind: "download" };

type DirectoryPicker = (opts: {
  id?: string;
  mode?: "read" | "readwrite";
  startIn?: string;
}) => Promise<FileSystemDirectoryHandle>;

function directoryPicker(): DirectoryPicker | undefined {
  if (typeof window === "undefined" || Capacitor.isNativePlatform()) return undefined;
  const picker = (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  return typeof picker === "function" ? picker.bind(window) : undefined;
}

/** Whether a destination folder can be chosen here (Chromium, Electron). */
export function canChooseFolder(): boolean {
  return Boolean(directoryPicker());
}

/** Ask for a folder. Resolves null when the user cancels. Must run in a click. */
export async function chooseFolder(): Promise<FileSystemDirectoryHandle | null> {
  const picker = directoryPicker();
  if (!picker) return null;
  try {
    return await picker({ id: "armada-call-recordings", mode: "readwrite", startIn: "music" });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return null;
    throw err;
  }
}
