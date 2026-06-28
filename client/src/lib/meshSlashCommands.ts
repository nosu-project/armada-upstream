import { parseSlashCommand, type SlashCommand } from "@/lib/slashCommands";

/**
 * Slash commands that make sense on the Bluetooth mesh. The mesh has no
 * moderation, no relays and no threads, so the Nostr-only commands
 * (`/kick`, `/ban`, `/poll`, `/thread`) are excluded. What's left is pure text
 * rewrites plus `/mention`, which just opens the `@` picker.
 */
export const MESH_SLASH_NAMES = new Set(["me", "shrug", "tableflip", "unflip", "slap", "mention"]);

/** A mesh command name picked from the menu is one of the allowed set. */
export function isMeshSlashCommand(command: SlashCommand): boolean {
  return MESH_SLASH_NAMES.has(command.name);
}

export type MeshSlashResult =
  /** Send this (rewritten) text over the mesh. */
  | { type: "send"; text: string }
  /** Open the `@` picker, optionally seeding the draft with `prefix`. */
  | { type: "openMention"; prefix?: string }
  /** Show an error to the user; send nothing. */
  | { type: "error"; message: string }
  /** Not a (mesh) slash command — send the original text literally. */
  | { type: "passthrough" };

/**
 * Interpret a draft as a mesh slash command. Reuses the shared command engine
 * (`parseSlashCommand` + each command's `run`) but restricts execution to the
 * mesh-appropriate set and maps the engine's result onto mesh outcomes (mesh
 * has no moderation context, so `canModerate` is always false).
 */
export function runMeshSlashCommand(draft: string): MeshSlashResult {
  const parsed = parseSlashCommand(draft);
  if (!parsed) return { type: "passthrough" };
  if (!isMeshSlashCommand(parsed.command)) {
    // A real command word, but not one the mesh supports — surface it rather
    // than silently sending "/kick …" as a literal message.
    return { type: "error", message: `/${parsed.command.name} isn't available in mesh chat.` };
  }

  const result = parsed.command.run(parsed.arg, {
    canModerate: false,
    resolvePubkey: () => undefined,
  });

  switch (result.type) {
    case "send":
      return { type: "send", text: result.text };
    case "error":
      return { type: "error", message: result.message };
    case "action":
      if (result.action.kind === "openMention") {
        return { type: "openMention", prefix: result.action.prefix };
      }
      // No other action kinds are reachable for the mesh command set.
      return { type: "passthrough" };
    default:
      return { type: "passthrough" };
  }
}
