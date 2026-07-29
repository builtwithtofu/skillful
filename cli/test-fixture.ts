import { chmodSync, cpSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

function makeWritable(path: string) {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    chmodSync(path, 0o755);
    for (const entry of readdirSync(path)) makeWritable(join(path, entry));
  } else if (stat.isFile()) chmodSync(path, stat.mode | 0o200);
}

export function copyBasicFixture(destination: string) {
  cpSync(join(import.meta.dir, "..", "templates", "basic"), destination, { recursive: true });
  makeWritable(destination);
}
