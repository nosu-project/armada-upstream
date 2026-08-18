import fs from "node:fs";
import path from "node:path";

import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const builder = loadYaml(
  fs.readFileSync(path.resolve(root, "electron/electron-builder.yml"), "utf8"),
);
const workflowSource = fs.readFileSync(
  path.resolve(root, ".ngit/act/workflows/desktop.yml"),
  "utf8",
);
const workflow = loadYaml(workflowSource);
const deployScript = workflow.jobs.desktop.steps.find(
  (step) => step.name === "Deploy desktop installers and update repositories",
)?.run;

function shellCommands(script) {
  const commands = [];
  let pending = "";
  for (const rawLine of String(script || "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const continued = line.endsWith("\\");
    const fragment = continued ? line.slice(0, -1).trimEnd() : line;
    pending = pending ? `${pending} ${fragment}` : fragment;
    if (!continued) {
      commands.push(pending);
      pending = "";
    }
  }
  return commands;
}

const deployCommands = shellCommands(deployScript);

function commandIndexes(fragment) {
  return deployCommands.flatMap((command, index) =>
    command.includes(fragment) ? [index] : []
  );
}

describe("desktop update publication", () => {
  it("embeds the filesystem-backed downloads feed in Electron packages", () => {
    expect(builder.publish).toEqual({
      provider: "generic",
      url: "https://armada.buzz/downloads/desktop",
    });
  });

  it("deploys both machine repositories beneath downloads and verifies them publicly", () => {
    expect(deployCommands).toContain(
      "rsync -av --chmod=D755,F644 -e ssh --exclude='latest*.yml' \"$DEPLOY_ROOT/desktop/\" \"${TARGET}:/downloads/desktop/\"",
    );
    expect(deployCommands).toContain(
      "rsync -av --chmod=D755,F644 -e ssh --include='latest*.yml' --exclude='*' \"$DEPLOY_ROOT/desktop/\" \"${TARGET}:/downloads/desktop/\"",
    );
    expect(deployCommands).toContain(
      "rsync -av --chmod=D755,F644 -e ssh --exclude='summary*' \"$DEPLOY_ROOT/flatpak/\" \"${TARGET}:/downloads/flatpak/\"",
    );
    expect(deployCommands).toContain(
      "rsync -av --chmod=D755,F644 -e ssh --include='summary*' --exclude='*' \"$DEPLOY_ROOT/flatpak/\" \"${TARGET}:/downloads/flatpak/\"",
    );
    expect(deployCommands).toContain(
      "curl -fsS --retry 5 --retry-all-errors \"https://armada.buzz/downloads/desktop/$name\" -o \"$smoke/$name\"",
    );
    expect(deployCommands).toContain(
      "cmp \"$DEPLOY_ROOT/desktop/$name\" \"$smoke/$name\"",
    );
    expect(deployCommands).toContain(
      "curl -fsS --retry 5 --retry-all-errors \"https://armada.buzz/downloads/flatpak/$name\" -o \"$smoke/flatpak-$name\"",
    );
    expect(deployCommands).toContain(
      "cmp \"$DEPLOY_ROOT/flatpak/$name\" \"$smoke/flatpak-$name\"",
    );
  });

  it("keeps legacy clients current and publishes mutable pointers last", () => {
    expect(deployCommands).toContain(
      "rsync -av --chmod=D755,F644 -e ssh --exclude='latest*.yml' \"$DEPLOY_ROOT/desktop/\" \"${TARGET}:/desktop/\"",
    );
    expect(deployCommands).toContain(
      "rsync -av --chmod=D755,F644 -e ssh --include='latest*.yml' --exclude='*' \"$DEPLOY_ROOT/desktop/\" \"${TARGET}:/desktop/\"",
    );
    expect(deployCommands).toContain(
      "rsync -av --chmod=D755,F644 -e ssh --exclude='summary*' \"$DEPLOY_ROOT/flatpak/\" \"${TARGET}:/flatpak/\"",
    );
    expect(deployCommands).toContain(
      "rsync -av --chmod=D755,F644 -e ssh --include='summary*' --exclude='*' \"$DEPLOY_ROOT/flatpak/\" \"${TARGET}:/flatpak/\"",
    );

    const flatpakPayloads = commandIndexes("--exclude='summary*'");
    const flatpakPointers = commandIndexes("--include='summary*'");
    const electronPayloads = commandIndexes("--exclude='latest*.yml'");
    const electronPointers = commandIndexes("--include='latest*.yml'");
    expect(flatpakPayloads).toHaveLength(2);
    expect(flatpakPointers).toHaveLength(2);
    expect(electronPayloads).toHaveLength(2);
    expect(electronPointers).toHaveLength(2);
    expect(Math.max(...flatpakPayloads)).toBeLessThan(
      Math.min(...flatpakPointers),
    );
    expect(Math.max(...electronPayloads)).toBeLessThan(
      Math.min(...electronPointers),
    );
  });
});
