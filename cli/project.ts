import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseMod, type SkillMod } from "./mod.ts";
import { BASIC_SCAFFOLD } from "./scaffold.ts";

export class ProjectError extends Error {
  constructor(message: string, readonly recovery: string) { super(message); }
}
export type Project = { root: string; sourceRoot: string; modPath: string; mod: SkillMod };

function error(message: string, recovery: string): never { throw new ProjectError(message, recovery); }
function scaffoldTree(entries: string[]) {
  const directories = new Set<string>();
  for (const entry of entries) {
    let parent = dirname(entry);
    while (parent !== ".") { directories.add(`${parent}/`); parent = dirname(parent); }
  }
  return [...directories, ...entries].sort();
}
function portableEntries(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(prefix, entry.name);
      return entry.isDirectory() ? portableEntries(root, path) : [path];
    })
    .sort();
}
function portableTree(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(prefix, entry.name);
      return entry.isDirectory() ? [`${path}/`, ...portableTree(root, path)] : [path];
    })
    .sort();
}

export function isInside(root: string, path: string) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function discoverSourceRoot(projectRoot: string) {
  let candidate = projectRoot;
  while (true) {
    if (existsSync(join(candidate, ".git")) || existsSync(join(candidate, ".jj"))) return realpathSync(candidate);
    const parent = dirname(candidate);
    if (parent === candidate) return projectRoot;
    candidate = parent;
  }
}

export function discoverProject({ cwd = process.cwd(), project, sourceRoot }: { cwd?: string | undefined; project?: string | undefined; sourceRoot?: string | undefined } = {}): Project {
  let root: string;
  if (project) {
    const selected = resolve(cwd, project);
    if (!existsSync(selected) || !statSync(selected).isDirectory()) error(`project directory does not exist: ${selected}`, "Pass an existing directory to --project containing skill.mod.");
    root = realpathSync(selected);
    if (!existsSync(join(root, "skill.mod"))) error(`no skill.mod in project directory: ${root}`, "Create it with `skillful init --dir " + root + "` or choose a directory containing skill.mod.");
  } else {
    let candidate = resolve(cwd);
    while (true) {
      if (existsSync(join(candidate, "skill.mod"))) { root = realpathSync(candidate); break; }
      const parent = dirname(candidate);
      if (parent === candidate) error(`no skill.mod found from ${resolve(cwd)} through its ancestors; create one with skillful init or select one with --project DIR`, "Run `skillful init` to create a project, or pass `--project DIR`.");
      candidate = parent;
    }
  }
  const selectedSource = sourceRoot === undefined ? undefined : resolve(cwd, sourceRoot);
  if (selectedSource !== undefined && (!existsSync(selectedSource) || !statSync(selectedSource).isDirectory())) error(`source root does not exist: ${selectedSource}`, "Pass an existing source root containing the project.");
  const selectedSourceRoot = selectedSource === undefined ? discoverSourceRoot(root!) : realpathSync(selectedSource);
  if (!isInside(selectedSourceRoot, root!)) error(`project directory is outside its source root: ${root}`, "Choose a source root that contains the project directory.");
  const modPath = join(root!, "skill.mod");
  try { return { root: root!, sourceRoot: selectedSourceRoot, modPath, mod: parseMod(readFileSync(modPath, "utf8"), modPath) }; }
  catch (cause) {
    if (cause instanceof ProjectError) throw cause;
    throw cause;
  }
}

export function resolveProjectPath(project: Project, value: string, kind: "directory" | "file") {
  if (isAbsolute(value)) error(`${kind} path must be relative to the project root: ${value}`, "Use a relative path inside skill.mod.");
  const path = resolve(project.root, value);
  if (relative(project.root, path).startsWith("..") || relative(project.root, path) === "") error(`${kind} path escapes the project root: ${value}`, "Choose a path that remains inside the project root.");
  if (!existsSync(path)) error(`${kind} path does not exist: ${value}`, "Create the path or update skill.mod, then run `skillful fmt`.");
  const stats = lstatSync(path);
  if ((kind === "directory" && !stats.isDirectory()) || (kind === "file" && !stats.isFile())) error(`${kind} path has the wrong type: ${value}`, "Point the directive at an existing " + kind + ".");
  return path;
}

export function initProject(destination = process.cwd()) {
  const target = resolve(destination);
  const expected = Object.keys(BASIC_SCAFFOLD).sort();
  const expectedTree = scaffoldTree(expected);
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) error(`init destination is not a directory: ${target}`, "Choose a directory with `--dir DIR`.");
    const actual = portableEntries(target);
    const actualTree = portableTree(target);
    const compatible = actualTree.length === expectedTree.length
      && actualTree.every((entry, index) => entry === expectedTree[index])
      && actual.length === expected.length
      && actual.every((entry, index) => entry === expected[index] && lstatSync(join(target, entry)).isFile() && readFileSync(join(target, entry), "utf8") === BASIC_SCAFFOLD[entry]);
    if (compatible) return { root: target, created: false };
    if (actualTree.length) error(`refusing to initialize non-empty destination: ${target}`, "Choose an empty directory, or remove unrelated files before running `skillful init`.");
  }
  mkdirSync(target, { recursive: true });
  for (const entry of expected) {
    const to = join(target, entry);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, BASIC_SCAFFOLD[entry]!, { flag: "wx", mode: 0o644 });
  }
  return { root: target, created: true };
}
