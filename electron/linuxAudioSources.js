"use strict";

// venmic treats every property passed to PatchBay.list() as required. Keep the
// discovery query to properties that playback streams consistently expose;
// asking for optional metadata such as application.process.binary or
// node.virtual makes older PipeWire/venmic combinations return an empty list.
const PLAYBACK_PROPERTIES = ["node.name", "application.name", "media.class"];
const PROCESS_PROPERTIES = ["node.name", "application.process.id"];

function listLinuxAudioApplications(patchBay, electronAudioProcessId) {
  const electronNodeNames = new Set();

  if (electronAudioProcessId) {
    for (const node of patchBay.list(PROCESS_PROPERTIES)) {
      if (node["application.process.id"] === electronAudioProcessId) {
        electronNodeNames.add(node["node.name"]);
      }
    }
  }

  const applications = new Map();
  for (const node of patchBay.list(PLAYBACK_PROPERTIES)) {
    if (node["media.class"] !== "Stream/Output/Audio") continue;
    if (electronNodeNames.has(node["node.name"])) continue;

    const name = node["application.name"];
    if (!name || applications.has(name)) continue;
    applications.set(name, {
      name,
      matcher: { "application.name": name },
    });
  }

  return [...applications.values()].sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  PLAYBACK_PROPERTIES,
  PROCESS_PROPERTIES,
  listLinuxAudioApplications,
};
