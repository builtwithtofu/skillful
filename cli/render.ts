import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { contractFor, resolvePlan, sha256, type ProjectPlan, type ResolveOptions } from "./contract.ts";
import type { HarnessId } from "./mod.ts";
import type { Project } from "./project.ts";

export type RenderOptions = ResolveOptions & {
  harnesses?: HarnessId[];
  out?: string;
  dryRun?: boolean;
  force?: boolean;
};
export type RenderChange = { path: string; action: "add" | "change" | "delete" };
export type RenderResult = { out: string; changes: RenderChange[]; dryRun: boolean };
type RenderState = {
  schemaVersion: 1;
  projectRoot: string;
  projectId: string;
  harness: HarnessId;
  files: Record<string, string>;
};

export class RenderOutputError extends Error {
  constructor(message: string, readonly recovery: string) { super(message); }
}
function fail(message: string, recovery: string): never { throw new RenderOutputError(message, `Recovery: ${recovery}`); }
function within(root: string, path: string) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}
function ensureSafeRelative(path: string) {
  if (!path || path.startsWith("/") || path.split(/[\\/]/).includes("..")) fail(`unsafe managed path: ${path}`, "Remove traversal components from the rendered resource name.");
  return path.replaceAll("\\", "/");
}
function filesUnder(root: string, prefix = ""): string[] {
  if (!existsSync(join(root, prefix))) return [];
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = join(prefix, entry.name);
    const full = join(root, path);
    if (entry.isDirectory()) return filesUnder(root, path);
    if (entry.isFile()) return [path.replaceAll("\\", "/")];
    fail(`managed output contains unsupported file kind: ${full}`, "Remove symlinks or special files from the render output.");
  }).sort();
}
function hashesUnder(root: string, excludeState = false) {
  return Object.fromEntries(filesUnder(root).filter((path) => !excludeState || path !== ".skillful/render.json").map((path) => [path, sha256(readFileSync(join(root, path)))]));
}
function writeText(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function copySupport(source: string, target: string) {
  const stat = lstatSync(source);
  if (!stat.isFile()) fail(`support source is not a regular file: ${source}`, "Use regular support files.");
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { force: false, errorOnExist: true, preserveTimestamps: false });
}
function projectId(project: Project) { return sha256(project.root); }
function statePath(root: string, harness: HarnessId) { return join(root, harness, ".skillful", "render.json"); }
function readState(root: string, harness: HarnessId): RenderState | null {
  const path = statePath(root, harness);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RenderState;
    if (parsed.schemaVersion !== 1 || parsed.harness !== harness || typeof parsed.projectId !== "string" || !parsed.files || typeof parsed.files !== "object") throw new Error("shape");
    return parsed;
  } catch {
    fail(`invalid managed render state: ${path}`, "Move the output aside, or deliberately rerun render with --force.");
  }
}
function verifyManaged(root: string, harness: HarnessId, state: RenderState, force: boolean) {
  for (const [path, expected] of Object.entries(state.files)) {
    const safe = ensureSafeRelative(path);
    const full = resolve(root, harness, safe);
    if (!within(resolve(root, harness), full)) fail(`managed path escapes ${harness}: ${path}`, "Repair or remove the render state before retrying.");
    const actual = existsSync(full) && lstatSync(full).isFile() ? sha256(readFileSync(full)) : null;
    if (actual !== expected && !force) fail(`managed render file was modified: ${join(harness, safe)}`, "Move your edits into project sources, restore the managed file, or deliberately rerun with --force.");
  }
}
function writeHarness(stage: string, plan: ProjectPlan, harness: HarnessId) {
  const selected = plan.harnesses[harness];
  const root = join(stage, harness);
  mkdirSync(join(root, "skills"), { recursive: true });
  mkdirSync(join(root, "commands"), { recursive: true });
  for (const skill of selected.skills) {
    const skillRoot = join(root, "skills", skill.name);
    writeText(join(skillRoot, "SKILL.md"), skill.body);
    for (const support of skill.supportFiles) {
      const privateSupport = support as typeof support & { sourcePath?: string; relativePath?: string };
      if (!privateSupport.sourcePath || !privateSupport.relativePath) fail(`renderer lost support source for ${skill.name}`, "Report this invariant violation with the project and skill name.");
      copySupport(privateSupport.sourcePath, join(skillRoot, privateSupport.relativePath));
    }
  }
  for (const command of selected.commands) writeText(join(root, "commands", command.name), command.body);
  writeText(join(root, "rules.md"), selected.rules.body);
  writeText(join(root, ".skillful", "contract.json"), `${JSON.stringify(contractFor(plan), null, 2)}\n`);
  const files = hashesUnder(root, true);
  const state: RenderState = { schemaVersion: 1, projectRoot: plan.project.root, projectId: projectId(plan.project), harness, files };
  writeText(join(root, ".skillful", "render.json"), `${JSON.stringify(state, null, 2)}\n`);
}
function plannedChanges(oldRoot: string | null, nextRoot: string, harnesses: HarnessId[]) {
  const changes: RenderChange[] = [];
  for (const harness of harnesses) {
    const oldFiles = oldRoot && existsSync(join(oldRoot, harness)) ? hashesUnder(join(oldRoot, harness)) : {};
    const nextFiles = hashesUnder(join(nextRoot, harness));
    for (const path of [...new Set([...Object.keys(oldFiles), ...Object.keys(nextFiles)])].sort()) {
      if (!(path in oldFiles)) changes.push({ path: `${harness}/${path}`, action: "add" });
      else if (!(path in nextFiles)) changes.push({ path: `${harness}/${path}`, action: "delete" });
      else if (oldFiles[path] !== nextFiles[path]) changes.push({ path: `${harness}/${path}`, action: "change" });
    }
  }
  return changes;
}
export function commitStagedTree(stage: string, target: string, operations = { renameSync, rmSync }) {
  if (!existsSync(target)) { operations.renameSync(stage, target); return; }
  const backup = `${target}.skillful-backup-${randomUUID()}`;
  operations.renameSync(target, backup);
  try {
    operations.renameSync(stage, target);
  } catch (cause) {
    try { operations.renameSync(backup, target); }
    catch (restoreCause) {
      fail(`failed to install rendered tree and failed to restore its backup: ${String(cause)}; restore failure: ${String(restoreCause)}`, `Keep both paths. Inspect ${stage} and ${backup}, then restore with: mv ${backup} ${target}`);
    }
    throw cause;
  }
  operations.rmSync(backup, { recursive: true, force: true });
}

export function renderProject(project: Project, options: RenderOptions = {}): RenderResult {
  const plan = resolvePlan(project, options);
  const harnesses = options.harnesses?.length ? [...new Set(options.harnesses)] : Object.keys(plan.harnesses) as HarnessId[];
  const target = resolve(project.root, options.out ?? "rendered");
  if (target === project.root) fail(`render output cannot replace the project root: ${target}`, "Choose a separate --out directory.");
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  const stage = join(parent, `.${basename(target)}.skillful-stage-${randomUUID()}`);
  const targetExists = existsSync(target);
  try {
    if (targetExists) {
      if (!statSync(target).isDirectory()) fail(`render output is not a directory: ${target}`, "Move it aside or choose another --out directory.");
      const existingFiles = filesUnder(target);
      const states = harnesses.map((harness) => [harness, readState(target, harness)] as const);
      const unmanaged = existingFiles.length > 0 && states.every(([, state]) => state === null);
      if (unmanaged && !options.force) fail(`refusing to replace non-empty unmanaged render output: ${target}`, "Choose another --out directory, move it aside, or deliberately rerun with --force.");
      for (const [harness, state] of states) if (state) {
        if (state.projectId !== projectId(project) && !options.force) fail(`render output for ${harness} belongs to another project`, "Choose another --out directory or deliberately rerun with --force.");
        verifyManaged(target, harness, state, Boolean(options.force));
      }
      cpSync(target, stage, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
    } else mkdirSync(stage, { recursive: true });
    for (const harness of harnesses) {
      rmSync(join(stage, harness), { recursive: true, force: true });
      writeHarness(stage, plan, harness);
    }
    const changes = plannedChanges(targetExists ? target : null, stage, harnesses);
    if (options.dryRun) { rmSync(stage, { recursive: true, force: true }); return { out: target, changes, dryRun: true }; }
    commitStagedTree(stage, target);
    return { out: target, changes, dryRun: false };
  } catch (cause) {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
    throw cause;
  }
}
