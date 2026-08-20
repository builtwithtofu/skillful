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
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { sha256, type ResolveOptions } from "./contract.ts";
import { HARNESS_IDS, type HarnessId } from "./mod.ts";
import type { Project } from "./project.ts";
import { renderProject } from "./render.ts";
import { loadHarnesses, type HarnessFacts } from "./harness.ts";
import type { ResolvedSetup } from "./setup.ts";

export type InstallPaths = { skills: string; commands?: string; rules?: string };
type CommonInstallOptions = ResolveOptions & {
  root?: string | undefined;
  dryRun?: boolean | undefined;
  force?: boolean | undefined;
  stateHome?: string | undefined;
};
export type InstallOptions = CommonInstallOptions & {
  harness: HarnessId;
  paths?: Partial<InstallPaths> | undefined;
};
export type InstallSetupOptions = CommonInstallOptions;
export type RemoveSetupOptions = {
  root?: string | undefined;
  dryRun?: boolean | undefined;
  stateHome?: string | undefined;
};
export type InstallChange = { path: string; action: "add" | "change" | "delete" };
export type InstallResult = { root: string; statePath: string; changes: InstallChange[]; dryRun: boolean };
type StoredHarnessId = HarnessId | "opencode-v2";
type InstallState = {
  schemaVersion: 1;
  projectRoot: string;
  harness?: StoredHarnessId | undefined;
  setup?: string | undefined;
  destinationRoot: string;
  files: Record<string, string>;
};
type InstallOwner = { harness: StoredHarnessId } | { setup: string };
export class InstallError extends Error { constructor(message: string, readonly recovery: string) { super(message); } }
function fail(message: string, recovery: string): never { throw new InstallError(message, `Recovery: ${recovery}`); }
function inside(root: string, path: string) { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`)); }
function safeRelative(path: string) {
  const portable = path.replaceAll("\\", "/");
  if (!portable || portable.startsWith("/") || portable.split("/").includes("..")) fail(`unsafe installation path: ${path}`, "Harness install paths must remain inside --root.");
  const normalized = posix.normalize(portable);
  return normalized === "." ? normalized : normalized.replace(/\/+$/, "");
}
export function pathConflict(left: string, right: string, caseInsensitive = false) {
  if (left === "." || right === ".") return true;
  const normalize = (path: string) => {
    const portable = path.replaceAll("\\", "/");
    return caseInsensitive ? portable.toLowerCase() : portable;
  };
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
function caseInsensitiveFilesystem(root: string) {
  let current = root;
  while (true) {
    const name = basename(current);
    const alternate = name.replace(/[A-Za-z]/, (character) => character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase());
    if (alternate !== name) {
      const candidate = join(dirname(current), alternate);
      if (existsSync(candidate)) {
        const original = statSync(current);
        const alias = statSync(candidate);
        if (original.dev === alias.dev && original.ino === alias.ino) return true;
      }
    }
    const parent = dirname(current);
    if (parent === current) return process.platform === "win32";
    current = parent;
  }
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
function isInstallState(value: unknown): value is InstallState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const files = state.files;
  const knownHarness = state.harness === "opencode-v2" || (HARNESS_IDS as readonly unknown[]).includes(state.harness);
  const knownSetup = typeof state.setup === "string";
  return state.schemaVersion === 1
    && typeof state.projectRoot === "string"
    && ((knownHarness && !knownSetup) || (knownSetup && !knownHarness))
    && typeof state.destinationRoot === "string"
    && !!files
    && typeof files === "object"
    && !Array.isArray(files)
    && Object.values(files).every((hash) => typeof hash === "string");
}
function stateOwner(state: InstallState) { return state.setup ? `setup ${state.setup}` : `harness ${state.harness}`; }
function readState(path: string): InstallState | null {
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isInstallState(state)) throw new Error("shape");
    return state;
  } catch { fail(`invalid installation state: ${path}`, "Move the state aside and inspect existing files before retrying."); }
}
function stateFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return stateFiles(path);
    return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
  });
}
function withInstallLock<T>(base: string, operation: () => T): T {
  mkdirSync(base, { recursive: true });
  const lock = join(base, ".install.lock");
  try { mkdirSync(lock); }
  catch (error) {
    if (existsSync(lock)) fail(`another installation is running`, `Wait for it to finish. If no install is running, remove ${lock} and retry.`);
    throw error;
  }
  try { return operation(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
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
function ownershipTarget(root: string, relativePath: string) {
  const safe = safeRelative(relativePath);
  verifyDestinationPath(root, safe);
  const parts = safe.split("/");
  let current = root;
  for (const [index, part] of parts.entries()) {
    const candidate = resolve(current, part);
    if (!existsSync(candidate)) return resolve(current, ...parts.slice(index));
    current = realpathSync(candidate);
  }
  return current;
}
export function resolveInstallPaths(facts: HarnessFacts, overrides?: Partial<InstallPaths>, scope: "home" | "project" = "home") {
  const defaults = facts.installPaths[scope];
  if (overrides?.commands !== undefined && defaults.commands === undefined) fail(`commands path is not supported by ${facts.name}`, "Remove the commands path override; this harness delivers commands as skills.");
  const commands = overrides?.commands ?? defaults.commands;
  const rules = overrides?.rules ?? defaults.rules;
  const selected: InstallPaths = {
    skills: safeRelative(overrides?.skills ?? defaults.skills),
    ...(commands ? { commands: safeRelative(commands) } : {}),
    ...(rules ? { rules: safeRelative(rules) } : {}),
  };
  const named = Object.entries(selected);
  for (const [index, [leftName, leftPath]] of named.entries()) {
    for (const [rightName, rightPath] of named.slice(index + 1)) {
      if (pathConflict(leftPath, rightPath)) fail(`overlapping installation paths: ${leftName} ${leftPath} and ${rightName} ${rightPath}`, "Choose destinations that do not share a path prefix.");
    }
  }
  return selected;
}

function collectArtifacts(renderRoot: string, harness: HarnessId, installPaths: InstallPaths) {
  const root = join(renderRoot, harness);
  const files = new Map<string, string>();
  for (const path of filesUnder(join(root, "skills"))) files.set(safeRelative(join(installPaths.skills, path)), join(root, "skills", path));
  if (installPaths.commands) for (const path of filesUnder(join(root, "commands"))) files.set(safeRelative(join(installPaths.commands, path)), join(root, "commands", path));
  if (installPaths.rules) files.set(safeRelative(installPaths.rules), join(root, "rules.md"));
  return files;
}

function assertUnowned(destinationRoot: string, files: Iterable<string>, ignoredStatePaths: ReadonlySet<string>, base: string, caseInsensitive: boolean) {
  const desired = [...files].map((file) => ({ file, target: ownershipTarget(destinationRoot, file) }));
  for (const path of stateFiles(base)) {
    if (ignoredStatePaths.has(path)) continue;
    const sibling = readState(path);
    if (!sibling) continue;
    for (const entry of desired) {
      for (const owned of Object.keys(sibling.files)) {
        if (pathConflict(entry.target, ownershipTarget(sibling.destinationRoot, owned), caseInsensitive)) {
          fail(
            `destination already owned by another installation: ${entry.file}`,
            `Owned by ${stateOwner(sibling)} at ${sibling.destinationRoot} from ${sibling.projectRoot}. Choose another --path or --root.`,
          );
        }
      }
    }
  }
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

function owns(state: InstallState, owner: InstallOwner) {
  return "harness" in owner ? state.harness === owner.harness : state.setup === owner.setup;
}
function assertStateIdentity(state: InstallState, path: string, projectRoot: string, destinationRoot: string, owner: InstallOwner) {
  if (state.projectRoot !== projectRoot || state.destinationRoot !== destinationRoot || !owns(state, owner)) {
    fail(`installation state identity mismatch: ${path}`, "Move the state aside and inspect the destination before retrying.");
  }
}
type ReceiptSpec = { path: string; owner: InstallOwner };
type ApplyInstallationOptions = {
  projectRoot: string;
  destinationRoot: string;
  base: string;
  statePath: string;
  receipts: ReceiptSpec[];
  adoptions?: ReceiptSpec[] | undefined;
  owner: InstallOwner;
  artifacts: Map<string, string>;
  regions: string[];
  dryRun?: boolean | undefined;
  force?: boolean | undefined;
};
function physicalTargets(destinationRoot: string, files: Iterable<string>) {
  return [...files].map((file) => ({ file, target: ownershipTarget(destinationRoot, file) }));
}
function assertDistinctPhysicalTargets(targets: Array<{ file: string; target: string }>, caseInsensitive: boolean) {
  for (const [index, left] of targets.entries()) for (const right of targets.slice(index + 1)) {
    if (pathConflict(left.target, right.target, caseInsensitive)) fail(
      `overlapping physical installation destinations: ${left.file} and ${right.file}`,
      "Choose destinations that do not meet through a path or symlink alias.",
    );
  }
}
function applyInstallation(options: ApplyInstallationOptions): InstallResult {
  const nextHashes = Object.fromEntries([...options.artifacts].map(([path, source]) => [path, sha256(readFileSync(source))]));
  return withInstallLock(options.base, () => {
    const caseInsensitive = caseInsensitiveFilesystem(options.destinationRoot);
    const desired = physicalTargets(options.destinationRoot, Object.keys(nextHashes));
    const regions = physicalTargets(options.destinationRoot, options.regions);
    assertDistinctPhysicalTargets(regions, caseInsensitive);
    assertDistinctPhysicalTargets(desired, caseInsensitive);
    const receipts = options.receipts.map((receipt) => ({ ...receipt, state: readState(receipt.path) }));
    for (const candidate of options.adoptions ?? []) {
      const state = readState(candidate.path);
      if (!state) continue;
      const overlaps = regions.some((entry) => Object.keys(state.files).some((owned) => pathConflict(entry.target, ownershipTarget(state.destinationRoot, owned), caseInsensitive)));
      if (overlaps) receipts.push({ ...candidate, state });
    }
    for (const receipt of receipts) if (receipt.state) assertStateIdentity(receipt.state, receipt.path, options.projectRoot, options.destinationRoot, receipt.owner);
    assertUnowned(options.destinationRoot, Object.keys(nextHashes), new Set(receipts.map((receipt) => receipt.path)), options.base, caseInsensitive);
    const oldHashes: Record<string, string> = {};
    for (const receipt of receipts) for (const [path, hash] of Object.entries(receipt.state?.files ?? {})) {
      if (oldHashes[path] && oldHashes[path] !== hash) fail(`conflicting installation ownership: ${path}`, "Move one receipt aside and inspect the destination before retrying.");
      oldHashes[path] = hash;
    }
    const stale = physicalTargets(options.destinationRoot, Object.keys(oldHashes).filter((path) => !(path in nextHashes)));
    for (const next of desired) for (const previous of stale) if (pathConflict(next.target, previous.target, caseInsensitive)) fail(
      `new installation path ${next.file} aliases a stale owned path ${previous.file}`,
      "Keep the existing path spelling or migrate through a destination that does not alias it.",
    );
    const changes: InstallChange[] = [];
    for (const path of [...new Set([...Object.keys(oldHashes), ...Object.keys(nextHashes)])].sort()) {
      const target = verifyDestinationPath(options.destinationRoot, path);
      const current = existsSync(target) && lstatSync(target).isFile() ? sha256(readFileSync(target)) : null;
      if (path in oldHashes) {
        if (current !== oldHashes[path] && (!(path in nextHashes) || !options.force)) fail(`owned installation file was modified: ${path}`, "Move your edits into project sources, restore the installed file, or choose another --root. --force cannot delete a changed stale file.");
        if (!(path in nextHashes)) changes.push({ path, action: "delete" });
        else if (current !== nextHashes[path]) changes.push({ path, action: current === null ? "add" : "change" });
      } else if (path in nextHashes) {
        if (current !== null && !options.force) fail(`unmanaged installation collision: ${path}`, "Move it, choose another --root, or deliberately rerun with --force.");
        if (current !== nextHashes[path]) changes.push({ path, action: current === null ? "add" : "change" });
      }
    }
    if (options.dryRun) return { root: options.destinationRoot, statePath: options.statePath, changes, dryRun: true };
    for (const change of changes.filter((entry) => entry.action !== "delete")) atomicWrite(options.artifacts.get(change.path)!, verifyDestinationPath(options.destinationRoot, change.path));
    for (const change of changes.filter((entry) => entry.action === "delete")) {
      const target = verifyDestinationPath(options.destinationRoot, change.path);
      if (existsSync(target)) { rmSync(target); removeEmptyParents(target, options.destinationRoot); }
    }
    const state: InstallState = { schemaVersion: 1, projectRoot: options.projectRoot, ...options.owner, destinationRoot: options.destinationRoot, files: nextHashes };
    mkdirSync(dirname(options.statePath), { recursive: true });
    const tempState = `${options.statePath}.tmp-${randomUUID()}`;
    writeFileSync(tempState, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tempState, options.statePath);
    for (const receipt of receipts) if (receipt.path !== options.statePath && receipt.state) {
      rmSync(receipt.path);
      removeEmptyParents(receipt.path, options.base);
    }
    return { root: options.destinationRoot, statePath: options.statePath, changes, dryRun: false };
  });
}
function setupStatePath(base: string, projectId: string, setup: string, rootId: string) {
  return join(base, projectId, "setups", setup, `${rootId}.json`);
}
function retiredOpenCodeReceipt(base: string, projectId: string, rootId: string): ReceiptSpec {
  return { path: join(base, projectId, "opencode-v2", `${rootId}.json`), owner: { harness: "opencode-v2" } };
}

export function installProject(project: Project, options: InstallOptions): InstallResult {
  const destinationRoot = canonicalDirectory(options.root ?? homedir(), "--root");
  const projectRoot = realpathSync(project.root);
  const projectId = sha256(projectRoot);
  const rootId = sha256(destinationRoot);
  const installPaths = resolveInstallPaths(loadHarnesses()[options.harness], options.paths);
  const base = stateBase(options.stateHome);
  const statePath = join(base, projectId, options.harness, `${rootId}.json`);
  const receipts: ReceiptSpec[] = [{ path: statePath, owner: { harness: options.harness } }];
  const adoptions = options.harness === "opencode" ? [retiredOpenCodeReceipt(base, projectId, rootId)] : [];
  const renderName = `.skillful-install-${randomUUID()}`;
  const renderRoot = join(project.root, renderName);
  try {
    renderProject(project, { harnesses: [options.harness], out: renderName, overrides: options.overrides, extraRoots: options.extraRoots, force: true });
    const regions = Object.values(installPaths).filter((path): path is string => Boolean(path));
    return applyInstallation({ projectRoot, destinationRoot, base, statePath, receipts, adoptions, owner: { harness: options.harness }, artifacts: collectArtifacts(renderRoot, options.harness, installPaths), regions, dryRun: options.dryRun, force: options.force });
  } finally { rmSync(renderRoot, { recursive: true, force: true }); }
}

export function installSetup(project: Project, setup: ResolvedSetup, options: InstallSetupOptions = {}): InstallResult {
  const destinationRoot = canonicalDirectory(options.root ?? (setup.root === "project" ? project.root : homedir()), "--root");
  const projectRoot = realpathSync(project.root);
  const projectId = sha256(projectRoot);
  const rootId = sha256(destinationRoot);
  const base = stateBase(options.stateHome);
  const statePath = setupStatePath(base, projectId, setup.name, rootId);
  const renderName = `.skillful-install-${randomUUID()}`;
  const renderRoot = join(project.root, renderName);
  try {
    renderProject(project, { setup: setup.name, out: renderName, overrides: options.overrides, extraRoots: options.extraRoots, force: true });
    const artifacts = new Map(Object.entries(setup.files).map(([destination, file]) => [destination, join(renderRoot, file.artifact)]));
    const adoptions = setup.harnesses.some((harness) => harness.name === "opencode") ? [retiredOpenCodeReceipt(base, projectId, rootId)] : [];
    const regions = setup.harnesses.flatMap((harness) => Object.values(harness.paths).filter((path): path is string => Boolean(path)));
    return applyInstallation({ projectRoot, destinationRoot, base, statePath, receipts: [{ path: statePath, owner: { setup: setup.name } }], adoptions, owner: { setup: setup.name }, artifacts, regions, dryRun: options.dryRun, force: options.force });
  } finally { rmSync(renderRoot, { recursive: true, force: true }); }
}
export function removeSetup(project: Project, setupName: string, options: RemoveSetupOptions = {}): InstallResult {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(setupName)) fail(`invalid setup name: ${setupName}`, "Pass the exact retired setup name from its former skill.mod declaration.");
  const declared = project.mod.setups[setupName];
  if (!options.root && !declared) fail(`--root is required after setup ${setupName} is removed from skill.mod`, "Pass the exact root used for the retired setup installation.");
  const declaredRoot = declared?.root === "project" ? project.root : homedir();
  const destinationRoot = canonicalDirectory(options.root ?? declaredRoot, "--root");
  const projectRoot = realpathSync(project.root);
  const projectId = sha256(projectRoot);
  const rootId = sha256(destinationRoot);
  const base = stateBase(options.stateHome);
  const statePath = setupStatePath(base, projectId, setupName, rootId);
  return withInstallLock(base, () => {
    const state = readState(statePath);
    if (!state) fail(`no installation receipt for setup ${setupName} under ${destinationRoot}`, "Pass the original --root, or leave the retired setup installed.");
    assertStateIdentity(state, statePath, projectRoot, destinationRoot, { setup: setupName });
    const paths = Object.keys(state.files).sort();
    assertUnowned(destinationRoot, paths, new Set([statePath]), base, caseInsensitiveFilesystem(destinationRoot));
    for (const path of paths) {
      const target = verifyDestinationPath(destinationRoot, path);
      const current = existsSync(target) && lstatSync(target).isFile() ? sha256(readFileSync(target)) : null;
      if (current !== state.files[path]) fail(`owned installation file was modified or removed: ${path}`, "Move edits aside, restore the recorded installed file, retry removal, then restore your file if wanted.");
    }
    const changes = paths.map((path): InstallChange => ({ path, action: "delete" }));
    if (options.dryRun) return { root: destinationRoot, statePath, changes, dryRun: true };
    for (const path of paths) {
      const target = verifyDestinationPath(destinationRoot, path);
      rmSync(target);
      removeEmptyParents(target, destinationRoot);
    }
    rmSync(statePath);
    removeEmptyParents(statePath, base);
    return { root: destinationRoot, statePath, changes, dryRun: false };
  });
}
