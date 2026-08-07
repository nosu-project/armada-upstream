import { access, cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const electronDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(electronDir, "..", "dist");
const target = path.resolve(electronDir, "dist");

await access(path.join(source, "index.html"));
await rm(target, { force: true, recursive: true });
await cp(source, target, { recursive: true });
await access(path.join(target, "index.html"));

console.log(`Staged current web bundle in ${target}`);
