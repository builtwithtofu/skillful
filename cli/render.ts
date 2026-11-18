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
import { contractFor, harnessIds, harnessPlan, publicSkill, resolvePlan, sha256, sharedSkillsPath, skillRoot, type ProjectPlan, type ResolveOptions, type SkillPlan } from "./contract.ts";
import { agentReadsShared, type HarnessId } from "./mod.ts";
import type { Project } from "./project.ts";

export type RenderOptions = ResolveOptions & {
  harnesses?: HarnessId[] | undefined;
  setup?: string | undefined;
  out?: string | undefined;
  dryRun?: boolean | undefined;
  force?: boolean | undefined;
};
export type RenderChange = { path: string; action: "add" | "change" | "delete" };
export type RenderResult = { out: string; changes: RenderChange[]; dryRun: boolean };

type RenderState = {
  schemaVersion: 1;
  projectRoot: string;
  projectId: string;
  harness: string;
  setup?: string | undefined;
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
function statePath(root: string, harness: string) { return join(root, harness, ".skillful", "render.json"); }
function readState(root: string, harness: string): RenderState | null {
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
function managedHarnesses(root: string) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(statePath(root, entry.name))).map((entry) => entry.name).sort();
}
function verifyManaged(root: string, harness: string, state: RenderState, force: boolean) {
  const harnessRoot = resolve(root, harness);
  const unmanaged = filesUnder(harnessRoot).filter((path) => path !== ".skillful/render.json" && !(path in state.files));
  if (unmanaged.length && !force) fail(`managed render contains unmanaged files under ${harness}: ${unmanaged.join(", ")}`, "Move them outside the render tree or deliberately rerun with --force.");
  for (const [path, expected] of Object.entries(state.files)) {
    const safe = ensureSafeRelative(path);
    const full = resolve(root, harness, safe);
    if (!within(resolve(root, harness), full)) fail(`managed path escapes ${harness}: ${path}`, "Repair or remove the render state before retrying.");
    const actual = existsSync(full) && lstatSync(full).isFile() ? sha256(readFileSync(full)) : null;
    if (actual !== expected && !force) fail(`managed render file was modified: ${join(harness, safe)}`, "Move your edits into project sources, restore the managed file, or deliberately rerun with --force.");
  }
}
function writeSkill(stage: string, root: string, skill: SkillPlan) {
  const skillRoot = join(stage, root, "skills", skill.name);
  writeText(join(skillRoot, "SKILL.md"), skill.body);
  for (const support of skill.supportFiles) {
    if (!support.relativePath) fail(`renderer lost support destination for ${skill.name}`, "Report this invariant violation with the project and skill name.");
    const target = join(skillRoot, support.relativePath);
    if (support.copied === "generated") {
      if (support.generatedBody === null) fail(`renderer lost generated support content for ${skill.name}`, "Report this invariant violation with the project and skill name.");
      writeText(target, support.generatedBody);
    } else {
      if (!support.sourcePath) fail(`renderer lost support source for ${skill.name}`, "Report this invariant violation with the project and skill name.");
      copySupport(support.sourcePath, target);
    }
  }
}

function writeSkills(stage: string, plan: ProjectPlan, setup: string | undefined) {
  const roots = new Set<string>();
  for (const { id, root, skill } of plan.placements) {
    if (root === id) continue;
    writeSkill(stage, root, skill);
    roots.add(root.split("/")[0]!);
  }
  for (const root of roots) writeState(stage, plan, root, setup);
}

export function writeHarnessArtifacts(stage: string, plan: ProjectPlan, harness: HarnessId, allSkills: boolean) {
  const selected = harnessPlan(plan, harness);
  const root = join(stage, harness);
  if (allSkills) mkdirSync(join(root, "skills"), { recursive: true });
  for (const skill of selected.skills) {
    if (allSkills || skill.transformations.command.length) writeSkill(stage, harness, skill);
  }
  mkdirSync(join(root, "commands"), { recursive: true });
  for (const command of selected.commands) writeText(join(root, "commands", command.name), command.body);
  writeText(join(root, "rules.md"), selected.rules.body);
}

function writeHarness(stage: string, plan: ProjectPlan, harness: HarnessId, setup: string | undefined) {
  writeHarnessArtifacts(stage, plan, harness, plan.project.mod.version === 1);
  const root = join(stage, harness);
  writeText(join(root, ".skillful", "contract.json"), `${JSON.stringify(contractFor(plan), null, 2)}\n`);
  writeState(stage, plan, harness, setup);
}

function refreshSkillContract(stage: string, plan: ProjectPlan, harness: HarnessId, force: boolean) {
  const path = ".skillful/contract.json";
  const root = join(stage, harness);
  if (!lstatSync(join(root, ".skillful")).isDirectory() || !lstatSync(join(root, path)).isFile() || !lstatSync(statePath(stage, harness)).isFile()) {
    fail(`invalid managed render metadata for ${harness}`, "Restore its render metadata or use a fresh --out directory.");
  }
  const state = readState(stage, harness)!;
  const previous = readFileSync(join(root, path), "utf8");
  if (state.projectId !== projectId(plan.project) && !force) fail(`render output for ${harness} belongs to another project`, "Choose another --out directory or deliberately rerun with --force.");
  if (sha256(previous) !== state.files[path] && !force) fail(`managed render file was modified: ${join(harness, path)}`, "Restore its contract or deliberately rerun with --force.");
  const contract = JSON.parse(previous) as ReturnType<typeof contractFor>;
  for (const id of [...harnessIds(plan), ...plan.regroupedSkills.keys()]) {
    const entry = contract.manifest.harnesses[id];
    if (!entry) continue;
    const skills = plan.regroupedSkills.get(id) ?? harnessPlan(plan, id).skills.filter((skill) => !skill.transformations.command.length);
    entry.skills = [...skills.map(publicSkill), ...entry.skills.filter((skill) => skill.transformations.command.length)]
      .sort((left, right) => left.name.localeCompare(right.name));
  }
  const next = `${JSON.stringify(contract, null, 2)}\n`;
  if (next === previous) return false;
  writeText(join(root, path), next);
  state.files[path] = sha256(next);
  writeText(statePath(stage, harness), `${JSON.stringify(state, null, 2)}\n`);
  return true;
}

function writeState(stage: string, plan: ProjectPlan, harness: string, setup: string | undefined) {
  const root = join(stage, harness);
  const files = hashesUnder(root, true);
  const state: RenderState = { schemaVersion: 1, projectRoot: plan.project.root, projectId: projectId(plan.project), harness, setup, files };
  writeText(join(root, ".skillful", "render.json"), `${JSON.stringify(state, null, 2)}\n`);
}
function plannedChanges(oldRoot: string | null, nextRoot: string, harnesses: string[]) {
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
  if (options.setup && options.harnesses?.length) fail("render cannot mix a setup with --harness", "Choose one named setup or one-off harness selection.");
  const sharedLayout = project.mod.version === 2;
  const target = resolve(project.root, options.out ?? "rendered");
  if (target === project.root) fail(`render output cannot replace the project root: ${target}`, "Choose a separate --out directory.");
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  const stage = join(parent, `.${basename(target)}.skillful-stage-${randomUUID()}`);
  const targetExists = existsSync(target);
  const existingManaged = targetExists && statSync(target).isDirectory() ? managedHarnesses(target) : [];
  const targeted = options.harnesses?.length ? options.harnesses : undefined;
  const previousLayout = sharedLayout && targeted
    ? [".agents", ...targeted].filter((id) => existingManaged.includes(id)).map((id) => readState(target, id)).find((state) => state?.setup && state.projectId === projectId(project))
    : undefined;
  const previousSetup = previousLayout?.setup;
  const setup = options.setup ?? (previousSetup && Object.hasOwn(project.mod.setups, previousSetup) ? previousSetup : undefined);
  const readsShared = (id: HarnessId) => agentReadsShared(project.mod, id, setup ? project.mod.setups[setup] : undefined);
  const sharedRender = sharedLayout && (!targeted || targeted.some(readsShared));
  const previouslyRendered = sharedRender && targeted
    ? existingManaged.filter(readsShared)
    : [];
  const plan = resolvePlan(project, { ...options, setup }, previouslyRendered);
  const harnesses = harnessIds(plan);
  const ownedHarnesses = [...new Set([
    ...harnesses,
    ...(sharedLayout ? [...harnesses, ...previouslyRendered].map((id) => skillRoot(id).split("/")[0]!) : []),
    ...(sharedRender ? [".agents"] : []),
    ...(!targeted ? existingManaged : []),
  ])].sort();
  try {
    if (targetExists) {
      if (!statSync(target).isDirectory()) fail(`render output is not a directory: ${target}`, "Move it aside or choose another --out directory.");
      const existingFiles = sharedLayout && existingManaged.length ? [] : filesUnder(target);
      const states = ownedHarnesses.map((harness) => [harness, readState(target, harness)] as const);
      const unmanaged = existingFiles.length > 0 && existingManaged.length === 0 && states.every(([, state]) => state === null);
      if (unmanaged && !options.force) fail(`refusing to replace non-empty unmanaged render output: ${target}`, "Choose another --out directory, move it aside, or deliberately rerun with --force.");
      for (const [harness, state] of states) {
        const hasFiles = existsSync(join(target, harness)) && filesUnder(join(target, harness)).length > 0;
        if (hasFiles && !state && !options.force) fail(`refusing to replace unmanaged render output for ${harness}`, "Move it aside, choose another --out directory, or deliberately rerun with --force.");
        if (state) {
          if (state.projectId !== projectId(project) && !options.force) fail(`render output for ${harness} belongs to another project`, "Choose another --out directory or deliberately rerun with --force.");
          verifyManaged(target, harness, state, Boolean(options.force));
        }
      }
      cpSync(target, stage, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
    } else mkdirSync(stage, { recursive: true });
    for (const harness of ownedHarnesses) rmSync(join(stage, harness), { recursive: true, force: true });
    for (const harness of harnesses) writeHarness(stage, plan, harness, sharedLayout ? setup : undefined);
    if (sharedLayout) writeSkills(stage, plan, setup);
    const changes = plannedChanges(targetExists ? target : null, stage, ownedHarnesses);
    for (const id of plan.regroupedSkills.keys()) {
      if (!refreshSkillContract(stage, plan, id, Boolean(options.force))) continue;
      changes.push({ path: `${id}/.skillful/contract.json`, action: "change" }, { path: `${id}/.skillful/render.json`, action: "change" });
    }
    if (targeted) {
      const removedSharedPaths = new Set(changes.filter(({ action, path }) => action === "delete" && path.startsWith(`${sharedSkillsPath}/`)).map(({ path }) => path));
      if (removedSharedPaths.size) for (const id of existingManaged) {
        if (ownedHarnesses.includes(id) || plan.regroupedSkills.has(id)) continue;
        const path = join(target, id, ".skillful", "contract.json");
        if (!existsSync(path)) continue;
        const { manifest } = JSON.parse(readFileSync(path, "utf8")) as ReturnType<typeof contractFor>;
        for (const skill of manifest.harnesses[id]?.skills ?? []) for (const { delivery } of [skill, ...skill.supportFiles]) {
          if (removedSharedPaths.has(delivery.path)) fail(`partial render would remove ${delivery.path} still used by ${id}`,
            setup ? `Run \`skillful render ${setup}\` to refresh all of the machine's outputs.` : "Run a full render without --harness, naming the machine if applicable.");
        }
      }
    }
    if (options.dryRun) { rmSync(stage, { recursive: true, force: true }); return { out: target, changes, dryRun: true }; }
    commitStagedTree(stage, target);
    return { out: target, changes, dryRun: false };
  } catch (cause) {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
    throw cause;
  }
}
