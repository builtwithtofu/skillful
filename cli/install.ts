import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { sha256, type ResolveOptions } from "./contract.ts";
import type { HarnessId } from "./mod.ts";
import type { Project } from "./project.ts";
import { renderProject } from "./render.ts";
import { loadHarnesses } from "./harness.ts";

export type InstallOptions = ResolveOptions & { harness: HarnessId; root?: string; dryRun?: boolean; force?: boolean; stateHome?: string };
export type InstallChange = { path: string; action: "add" | "change" | "delete" };
export type InstallResult = { root: string; statePath: string; changes: InstallChange[]; dryRun: boolean };
type InstallState = { schemaVersion: 1; projectRoot: string; projectId: string; harness: HarnessId; destinationRoot: string; rootId: string; files: Record<string, string> };

export class InstallError extends Error { constructor(message: string, readonly recovery: string) { super(message); } }
function fail(message: string, recovery: string): never { throw new InstallError(message, `Recovery: ${recovery}`); }
function inside(root: string, path: string) { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`)); }
function safeRelative(path: string) {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) fail(`unsafe installation path: ${path}`, "Harness install paths must remain inside --root.");
  return normalized;
}
function filesUnder(root: string, prefix = ""): string[] {
  if (!existsSync(join(root, prefix))) return [];
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) return filesUnder(root, path);
    if (entry.isFile()) return [path.replaceAll("\\", "/")];
    fail(`rendered artifact contains unsupported file kind: ${join(root, path)}`, "Use regular files and directories only.");
  }).sort();
}
function canonicalDirectory(path: string, label: string) {
  const selected = resolve(path);
  if (!existsSync(selected) || !statSync(selected).isDirectory()) fail(`${label} must be an existing directory: ${selected}`, `Create it first or choose another ${label}.`);
  return realpathSync(selected);
}
function stateBase(home?: string) { return resolve(home ?? process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "skillful", "installations"); }
function readState(path: string): InstallState | null {
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as InstallState;
    if (state.schemaVersion !== 1 || !state.files || typeof state.files !== "object") throw new Error("shape");
    return state;
  } catch { fail(`invalid installation state: ${path}`, "Move the state aside and inspect existing files before retrying."); }
}
function verifyDestinationPath(root: string, relativePath: string) {
  const safe = safeRelative(relativePath);
  const target = resolve(root, safe);
  if (!inside(root, target)) fail(`installation path escapes --root: ${relativePath}`, "Choose a safe destination root.");
  let current = root;
  for (const part of safe.split("/").slice(0, -1)) {
    current = join(current, part);
    if (!existsSync(current)) continue;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      const real = realpathSync(current);
      if (!inside(root, real)) fail(`installation path follows a symlink outside --root: ${relativePath}`, "Remove the symlink or choose another --root; --force never bypasses this check.");
    } else if (!stat.isDirectory()) fail(`installation parent is not a directory: ${current}`, "Move the collision or choose another --root.");
  }
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    const real = realpathSync(target);
    if (!inside(root, real)) fail(`installation target is a symlink outside --root: ${relativePath}`, "Remove the symlink or choose another --root; --force never bypasses this check.");
  }
  return target;
}
function collectArtifacts(renderRoot: string, harness: HarnessId) {
  const facts = loadHarnesses()[harness];
  const root = join(renderRoot, harness);
  const files = new Map<string, string>();
  for (const path of filesUnder(join(root, "skills"))) files.set(safeRelative(join(facts.installPaths.skills, path)), join(root, "skills", path));
  for (const path of filesUnder(join(root, "commands"))) files.set(safeRelative(join(facts.installPaths.commands, path)), join(root, "commands", path));
  if (facts.installPaths.rules) files.set(safeRelative(facts.installPaths.rules), join(root, "rules.md"));
  return files;
}
function atomicWrite(source: string, target: string) {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${target.split(sep).at(-1)}.skillful-${randomUUID()}`);
  copyFileSync(source, temporary);
  chmodSync(temporary, lstatSync(source).mode & 0o777);
  renameSync(temporary, target);
}
function removeEmptyParents(path: string, root: string) {
  let current = dirname(path);
  while (current !== root && inside(root, current)) {
    try { rmdirSync(current); }
    catch { break; }
    current = dirname(current);
  }
}

export function installProject(project: Project, options: InstallOptions): InstallResult {
  const destinationRoot = canonicalDirectory(options.root ?? homedir(), "--root");
  const projectRoot = realpathSync(project.root);
  const projectId = sha256(projectRoot);
  const rootId = sha256(destinationRoot);
  const statePath = join(stateBase(options.stateHome), projectId, options.harness, `${rootId}.json`);
  const previous = readState(statePath);
  if (previous && (previous.projectRoot !== projectRoot || previous.destinationRoot !== destinationRoot || previous.harness !== options.harness)) fail(`installation state identity mismatch: ${statePath}`, "Move the state aside and inspect the destination before retrying.");
  const renderName = `.skillful-install-${randomUUID()}`;
  const renderRoot = join(project.root, renderName);
  try {
    renderProject(project, { harnesses: [options.harness], out: renderName, overrides: options.overrides, extraRoots: options.extraRoots, force: true });
    const artifacts = collectArtifacts(renderRoot, options.harness);
    const nextHashes = Object.fromEntries([...artifacts].map(([path, source]) => [path, sha256(readFileSync(source))]));
    const oldHashes = previous?.files ?? {};
    const changes: InstallChange[] = [];
    for (const path of [...new Set([...Object.keys(oldHashes), ...Object.keys(nextHashes)])].sort()) {
      const target = verifyDestinationPath(destinationRoot, path);
      const current = existsSync(target) && lstatSync(target).isFile() ? sha256(readFileSync(target)) : null;
      if (path in oldHashes) {
        if (current !== oldHashes[path] && !options.force) fail(`owned installation file was modified: ${path}`, "Move your edits into project sources, restore the installed file, choose another --root, or deliberately rerun with --force.");
        if (!(path in nextHashes)) changes.push({ path, action: "delete" });
        else if (current !== nextHashes[path]) changes.push({ path, action: current === null ? "add" : "change" });
      } else if (path in nextHashes) {
        if (current !== null && !options.force) fail(`unmanaged installation collision: ${path}`, "Move it, choose another --root, or deliberately rerun with --force.");
        if (current !== nextHashes[path]) changes.push({ path, action: current === null ? "add" : "change" });
      }
    }
    if (options.dryRun) return { root: destinationRoot, statePath, changes, dryRun: true };
    for (const change of changes.filter((entry) => entry.action !== "delete")) atomicWrite(artifacts.get(change.path)!, verifyDestinationPath(destinationRoot, change.path));
    for (const change of changes.filter((entry) => entry.action === "delete")) {
      const target = verifyDestinationPath(destinationRoot, change.path);
      if (existsSync(target)) { rmSync(target); removeEmptyParents(target, destinationRoot); }
    }
    const state: InstallState = { schemaVersion: 1, projectRoot, projectId, harness: options.harness, destinationRoot, rootId, files: nextHashes };
    mkdirSync(dirname(statePath), { recursive: true });
    const tempState = `${statePath}.tmp-${randomUUID()}`;
    writeFileSync(tempState, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tempState, statePath);
    return { root: destinationRoot, statePath, changes, dryRun: false };
  } finally { rmSync(renderRoot, { recursive: true, force: true }); }
}
