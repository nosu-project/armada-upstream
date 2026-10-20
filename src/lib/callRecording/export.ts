import { Capacitor } from "@capacitor/core";

import { downloadBinaryFile } from "@/lib/downloadFile";
import type { RecordingDestination } from "@/lib/callRecording/folder";
import { FORMAT_EXTENSION, FORMAT_MIME, type RecordingFormat } from "@/lib/callRecording/formats";
import { STAGING_DIR, type StagedFile } from "@/lib/callRecording/protocol";
import { expandTemplate, uniqueName, type TemplateVars } from "@/lib/callRecording/template";

type PermissionedHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode: "readwrite" }) => Promise<PermissionState>;
};

async function stagingDir(id: string): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return (await root.getDirectoryHandle(STAGING_DIR)).getDirectoryHandle(id);
}

async function namesIn(dir: FileSystemDirectoryHandle): Promise<Set<string>> {
  const names = new Set<string>();
  for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.add(name);
  return names;
}

export interface ExportedFile {
  title: string;
  name: string;
}

/**
 * Copy a stopped take out of OPFS under its templated names, then delete the
 * staged copy. If anything fails, the staged files are kept so a retry (or a
 * later `exportRecording`) can still save them.
 */
export async function exportRecording(opts: {
  id: string;
  format: RecordingFormat;
  files: readonly StagedFile[];
  template: string;
  vars: Omit<TemplateVars, "user">;
  perUser: boolean;
  destination: RecordingDestination;
}): Promise<{ files: ExportedFile[]; location?: string }> {
  const ext = FORMAT_EXTENSION[opts.format];
  const staged = await stagingDir(opts.id);
  const out: ExportedFile[] = [];
  let location: string | undefined;

  let destination = opts.destination;
  if (destination.kind === "folder") {
    const handle = destination.handle as PermissionedHandle;
    const state = (await handle.queryPermission?.({ mode: "readwrite" })) ?? "granted";
    // A permission prompt needs a gesture we no longer have; fall back.
    if (state !== "granted") destination = { kind: "download" };
  }

  const takenFlat = new Set<string>();
  for (const file of opts.files) {
    const segments = expandTemplate(opts.template, { ...opts.vars, user: file.title }, { perUser: opts.perUser });
    const source = await (await staged.getFileHandle(file.staged)).getFile();

    if (destination.kind === "folder") {
      let dir = destination.handle;
      for (const segment of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(segment, { create: true });
      const name = uniqueName(segments[segments.length - 1], ext, await namesIn(dir));
      const target = await dir.getFileHandle(name, { create: true });
      const writable = await target.createWritable();
      await source.stream().pipeTo(writable);
      out.push({ title: file.title, name: [...segments.slice(0, -1), name].join("/") });
      continue;
    }

    const name = uniqueName(segments.join(" - "), ext, takenFlat);
    takenFlat.add(name);
    if (Capacitor.isNativePlatform()) {
      location = await downloadBinaryFile(name, new Uint8Array(await source.arrayBuffer()), FORMAT_MIME[opts.format]);
    } else {
      const url = URL.createObjectURL(source);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
    }
    out.push({ title: file.title, name });
  }

  // A browser download reads the staged file lazily; leave it time to finish.
  const remove = () => discardStaged(opts.id);
  if (destination.kind === "download" && !Capacitor.isNativePlatform()) setTimeout(remove, 5 * 60_000);
  else await remove();
  return { files: out, location };
}

export async function discardStaged(id: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await (await root.getDirectoryHandle(STAGING_DIR)).removeEntry(id, { recursive: true });
  } catch {
    // already gone
  }
}
