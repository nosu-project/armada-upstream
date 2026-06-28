import { describe, expect, it } from "vitest";

import { ME_ACTION_PREFIX } from "@/lib/slashCommands";
import { isMeshSlashCommand, runMeshSlashCommand } from "@/lib/meshSlashCommands";
import { SLASH_COMMANDS } from "@/lib/slashCommands";

describe("isMeshSlashCommand", () => {
  it("allows the mesh-appropriate commands", () => {
    for (const name of ["me", "shrug", "tableflip", "unflip", "slap", "mention"]) {
      const cmd = SLASH_COMMANDS.find((c) => c.name === name)!;
      expect(isMeshSlashCommand(cmd)).toBe(true);
    }
  });

  it("excludes moderation / relay-bound commands", () => {
    for (const name of ["kick", "ban", "poll", "thread"]) {
      const cmd = SLASH_COMMANDS.find((c) => c.name === name)!;
      expect(isMeshSlashCommand(cmd)).toBe(false);
    }
  });
});

describe("runMeshSlashCommand", () => {
  it("passes through non-command text", () => {
    expect(runMeshSlashCommand("hello there").type).toBe("passthrough");
    expect(runMeshSlashCommand("not/a/command").type).toBe("passthrough");
  });

  it("rewrites /me into a marked action line", () => {
    const r = runMeshSlashCommand("/me waves");
    expect(r).toEqual({ type: "send", text: `${ME_ACTION_PREFIX}waves` });
  });

  it("appends the shrug", () => {
    const r = runMeshSlashCommand("/shrug");
    expect(r.type).toBe("send");
    if (r.type === "send") expect(r.text).toContain("¯\\_(ツ)_/¯");
  });

  it("slaps a named target with the classic trout", () => {
    const r = runMeshSlashCommand("/slap @anon3f9a#6f70");
    expect(r.type).toBe("send");
    if (r.type === "send") {
      expect(r.text).toBe(`${ME_ACTION_PREFIX}slaps @anon3f9a#6f70 around a bit with a large trout`);
    }
  });

  it("opens the mention picker for /slap with no target", () => {
    expect(runMeshSlashCommand("/slap")).toEqual({ type: "openMention", prefix: "/slap " });
  });

  it("opens the mention picker for /mention", () => {
    expect(runMeshSlashCommand("/mention")).toEqual({ type: "openMention", prefix: undefined });
  });

  it("rejects unsupported commands instead of sending them literally", () => {
    expect(runMeshSlashCommand("/kick @someone").type).toBe("error");
    expect(runMeshSlashCommand("/poll").type).toBe("error");
  });

  it("surfaces an error for /me with no action", () => {
    expect(runMeshSlashCommand("/me").type).toBe("error");
  });
});
