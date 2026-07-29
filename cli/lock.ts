import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SkillMod } from "./mod.ts";

export type LockEntry = { name: string; ref: string; rev: string; narHash: string };
export class LockError extends Error { constructor(message: string, readonly recovery: string) { super(message); } }
function fail(message: string, recovery: string): never { throw new LockError(message, `Recovery: ${recovery}`); }
const namePattern = /^[a-z0-9][a-z0-9._-]*$/;
const hashPattern = /^sha256-[A-Za-z0-9+/]{43}=$/;
const revPattern = /^[0-9a-f]{40,64}$/;

export function parseLock(text: string, filename = "skill.lock") {
  if (/(^|\n)(<{7}|={7}|>{7})/.test(text)) fail(`${filename} contains a lock merge conflict`, "Resolve the conflict manually, keep one sorted pin per dependency, then run skillful fetch.");
  if (text.includes("\r")) fail(`${filename} must use LF line endings`, "Rewrite it with skillful update after preserving intended pins.");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (lines.length === 1 && lines[0] === "") return [];
  const entries: LockEntry[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const number = index + 1;
    if (!line || line.trim() !== line || /\s{2,}/.test(line)) fail(`${filename}:${number}: noncanonical spacing or blank line`, "Keep exactly four single-space-separated fields per line and run skillful update.");
    const fields = line.split(" ");
    if (fields.length !== 4) fail(`${filename}:${number}: expected name ref rev narHash`, "Keep exactly four fields; do not add comments or quotes.");
    const [name, ref, rev, narHash] = fields as [string, string, string, string];
    if (!namePattern.test(name)) fail(`${filename}:${number}: invalid dependency name ${name}`, "Use lowercase dependency names matching [a-z0-9][a-z0-9._-]*.");
    if (ref.startsWith("path:") || (!ref.startsWith("github:") && !ref.startsWith("git:"))) fail(`${filename}:${number}: unsupported locked ref ${ref}`, "Lock only github: and git: dependencies; path: dependencies stay unlocked.");
    if (!revPattern.test(rev)) fail(`${filename}:${number}: invalid resolved revision`, `Run skillful update ${name} to resolve a full commit ID.`);
    if (!hashPattern.test(narHash)) fail(`${filename}:${number}: invalid SRI sha256`, `Run skillful update ${name} to recreate the verified pin.`);
    entries.push({ name, ref, rev, narHash });
  }
  const names = entries.map((entry) => entry.name);
  if (new Set(names).size !== names.length) fail(`${filename} contains a duplicate dependency name`, "Keep one pin per dependency.");
  const sorted = [...names].sort();
  if (names.some((name, index) => name !== sorted[index])) fail(`${filename} is not sorted by dependency name`, "Run skillful update to rewrite the lock canonically.");
  return entries;
}
export function formatLock(entries: LockEntry[]) {
  const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name));
  return sorted.length ? `${sorted.map((entry) => `${entry.name} ${entry.ref} ${entry.rev} ${entry.narHash}`).join("\n")}\n` : "";
}
export function readLock(projectRoot: string, required = true) {
  const path = join(projectRoot, "skill.lock");
  if (!existsSync(path)) {
    if (!required) return [];
    fail(`missing skill.lock in ${projectRoot}`, "Run skillful add for a new dependency, or skillful fetch in an existing checkout.");
  }
  return parseLock(readFileSync(path, "utf8"), path);
}
export function validateLock(mod: SkillMod, entries: LockEntry[], overridden = new Set<string>()) {
  const remote = mod.requires.filter((requirement) => !requirement.ref.startsWith("path:") && !overridden.has(requirement.name));
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  for (const requirement of remote) {
    const entry = byName.get(requirement.name);
    if (!entry) fail(`dependency ${requirement.name} is declared but not locked`, `Run skillful add ${requirement.ref} --name ${requirement.name}, or skillful update ${requirement.name}.`);
    if (entry.ref !== requirement.ref) fail(`dependency ${requirement.name} changed from locked ref ${entry.ref} to ${requirement.ref}`, `Run skillful update ${requirement.name} to deliberately move the pin.`);
  }
  const declared = new Set(remote.map((requirement) => requirement.name));
  for (const entry of entries) if (!declared.has(entry.name) && !overridden.has(entry.name)) fail(`lock contains undeclared dependency ${entry.name}`, "Remove the stale line through skillful update after checking skill.mod.");
  return entries;
}
export function writeLockAtomic(projectRoot: string, entries: LockEntry[]) {
  const path = join(projectRoot, "skill.lock");
  const temporary = join(dirname(path), `.skill.lock.tmp-${randomUUID()}`);
  writeFileSync(temporary, formatLock(entries));
  renameSync(temporary, path);
}
