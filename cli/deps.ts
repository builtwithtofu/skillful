import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { cacheKey, narHash } from "./nar.ts";
import { readLock, readOverrideBaselines, pinFor, validateLock, writeLockAtomic, type LockEntry } from "./lock.ts";
import { formatMod, migrateMod, type Require, type SkillMod } from "./mod.ts";
import { isInside, resolveProjectPath, type Project } from "./project.ts";

export type ParsedRef =
  | { type: "github"; ref: string; identity: string; owner: string; repo: string; subdir: string | undefined; version: string }
  | { type: "git"; ref: string; identity: string; url: string; subdir: string | undefined; version: string }
  | { type: "path"; ref: string; identity: string; path: string };
export class DependencyError extends Error { constructor(message: string, readonly recovery: string) { super(message); } }
function fail(message: string, recovery: string): never { throw new DependencyError(message, `Recovery: ${recovery}`); }
function validateSubdir(value: string | undefined) {
  if (!value) return undefined;
  if (value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) fail(`invalid dependency subdirectory: ${value}`, "Use a non-empty relative subdirectory without . or ...");
  return value.replace(/\/$/, "");
}
export function parseRef(ref: string): ParsedRef {
  if (/\s/.test(ref)) fail(`dependency ref contains whitespace: ${ref}`, "Remove whitespace or encode it in the URL.");
  if (ref.startsWith("path:")) {
    const path = ref.slice(5);
    if (!path) fail("path dependency is empty", "Use path:relative/directory.");
    if (isAbsolute(path)) fail(`path dependency must be relative: ${path}`, "Use a path relative to skill.mod.");
    return { type: "path", ref, identity: `path:${path.replace(/\/$/, "")}`, path };
  }
  if (ref.startsWith("github:")) {
    const resolvedRef = ref.includes("@") ? ref : `${ref}@HEAD`;
    const at = resolvedRef.lastIndexOf("@");
    if (at <= "github:".length || at === resolvedRef.length - 1) fail(`GitHub ref needs @version: ${ref}`, "Use github:owner/repo[/subdir]@tag-or-revision.");
    const path = resolvedRef.slice("github:".length, at);
    const parts = path.split("/");
    if (parts.length < 2 || parts.some((part) => !part || part === "." || part === "..")) fail(`invalid GitHub ref: ${ref}`, "Use github:owner/repo[/subdir]@version.");
    const [owner, repo, ...rest] = parts;
    const subdir = validateSubdir(rest.length ? rest.join("/") : undefined);
    const identity = `github:${owner!.toLowerCase()}/${repo!.toLowerCase()}${subdir ? `/${subdir}` : ""}`;
    return { type: "github", ref: resolvedRef, identity, owner: owner!, repo: repo!, subdir, version: resolvedRef.slice(at + 1) };
  }
  if (ref.startsWith("git:")) {
    const hash = ref.indexOf("#");
    const beforeSubdir = hash === -1 ? ref : ref.slice(0, hash);
    const subdir = validateSubdir(hash === -1 ? undefined : ref.slice(hash + 1));
    const at = beforeSubdir.lastIndexOf("@");
    if (at <= "git:".length || at === beforeSubdir.length - 1) fail(`Git ref needs @version: ${ref}`, "Use git:<url>@tag-or-revision[#subdir].");
    const url = beforeSubdir.slice("git:".length, at);
    if (/^https?:\/\//.test(url)) {
      try { const parsed = new URL(url); if (parsed.username || parsed.password) fail("credential-bearing HTTP Git URLs are forbidden", "Use a credential helper or SSH URL; never put credentials in skill.mod."); }
      catch (cause) { if (cause instanceof DependencyError) throw cause; fail(`invalid Git URL: ${url}`, "Use a valid HTTP(S), SSH, file, or local Git URL."); }
    }
    const normalized = url.replace(/\/$/, "");
    return { type: "git", ref, identity: `git:${normalized}${subdir ? `#${subdir}` : ""}`, url, subdir, version: beforeSubdir.slice(at + 1) };
  }
  fail(`unsupported dependency ref: ${ref}`, "Use github:, git:, or path:.");
}
function git(args: string[], cwd?: string) {
  const command = cwd ? ["git", "-C", cwd, ...args] : ["git", ...args];
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (result.exitCode !== 0) fail(`Git command failed for dependency: ${args.join(" ")}`, new TextDecoder().decode(result.stderr).trim() || "Check the ref and credentials, then retry.");
  return new TextDecoder().decode(result.stdout);
}
export async function resolveRevision(parsed: Exclude<ParsedRef, { type: "path" }>) {
  if (parsed.type === "github") {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "skillful" };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/commits/${encodeURIComponent(parsed.version)}`, { headers });
    if (!response.ok) fail(`cannot resolve ${parsed.ref}: GitHub returned ${response.status}`, "Check the repository, version, and GITHUB_TOKEN permissions, then retry.");
    const value = await response.json() as { sha?: unknown };
    if (typeof value.sha !== "string" || !/^[0-9a-f]{40}$/.test(value.sha)) fail(`GitHub returned no commit for ${parsed.ref}`, "Choose a tag, branch, or commit that resolves to one commit.");
    return value.sha;
  }
  const lines = git(["ls-remote", parsed.url, parsed.version]).trim().split("\n").filter(Boolean);
  const peeled = lines.find((line) => line.endsWith("^{}"));
  const selected = peeled ?? lines[0];
  const rev = selected?.split(/\s+/, 1)[0];
  if (!rev || !/^[0-9a-f]{40,64}$/.test(rev)) fail(`cannot resolve ${parsed.ref}`, "Check the remote and version, then retry.");
  return rev;
}
function cacheRoot(explicit?: string) { return resolve(explicit ?? process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "skillful"); }
function verifyTree(path: string, expected: string, label: string) {
  const actual = narHash(path);
  if (actual !== expected) fail(`${label} hash mismatch: expected ${expected}, got ${actual}`, "Remove the tampered cache entry and run skillful fetch.");
}
async function downloadGitHub(parsed: Extract<ParsedRef, { type: "github" }>, rev: string, destination: string) {
  const response = await fetch(`https://codeload.github.com/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/tar.gz/${rev}`, { headers: { "User-Agent": "skillful" } });
  if (!response.ok) fail(`cannot fetch ${parsed.ref} at ${rev}: GitHub returned ${response.status}`, "Check network access and the locked revision, then retry.");
  const archive = join(dirname(destination), `.archive-${randomUUID()}.tar.gz`);
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  mkdirSync(destination, { recursive: true });
  const result = Bun.spawnSync(["tar", "-xzf", archive, "--strip-components=1", "-C", destination], { stdout: "pipe", stderr: "pipe" });
  rmSync(archive, { force: true });
  if (result.exitCode !== 0) fail(`cannot extract ${parsed.ref}`, new TextDecoder().decode(result.stderr).trim() || "Install tar and retry.");
}
function exportGit(parsed: Extract<ParsedRef, { type: "git" }>, rev: string, destination: string) {
  const checkout = join(tmpdir(), `skillful-git-${randomUUID()}`);
  const archive = join(tmpdir(), `skillful-git-${randomUUID()}.tar`);
  try {
    git(["clone", "--no-checkout", "--filter=blob:none", parsed.url, checkout]);
    git(["fetch", "--depth=1", "origin", rev], checkout);
    const result = Bun.spawnSync(["git", "-C", checkout, "archive", "--format=tar", "-o", archive, rev], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) fail(`cannot export ${parsed.ref} at ${rev}`, new TextDecoder().decode(result.stderr).trim() || "Prepare the commit locally and retry.");
    mkdirSync(destination, { recursive: true });
    const extract = Bun.spawnSync(["tar", "-xf", archive, "-C", destination], { stdout: "pipe", stderr: "pipe" });
    if (extract.exitCode !== 0) fail(`cannot extract ${parsed.ref}`, new TextDecoder().decode(extract.stderr).trim() || "Install tar and retry.");
  } finally { rmSync(checkout, { recursive: true, force: true }); rmSync(archive, { force: true }); }
}
async function fetchTree(parsed: Exclude<ParsedRef, { type: "path" }>, rev: string, destination: string) {
  if (parsed.type === "github") await downloadGitHub(parsed, rev, destination);
  else exportGit(parsed, rev, destination);
}
export async function fetchEntry(entry: LockEntry, explicitCache?: string) {
  const parsed = parseRef(entry.ref);
  if (parsed.type === "path") fail(`path dependency ${entry.name} cannot appear in skill.lock`, "Remove the lock line; path dependencies are read directly.");
  const root = cacheRoot(explicitCache);
  const target = join(root, cacheKey(entry.narHash));
  if (existsSync(target)) { verifyTree(target, entry.narHash, `cached dependency ${entry.name} (${entry.ref} at ${entry.rev})`); return target; }
  mkdirSync(root, { recursive: true });
  const stage = join(root, `.stage-${randomUUID()}`);
  try {
    await fetchTree(parsed, entry.rev, stage);
    verifyTree(stage, entry.narHash, `dependency ${entry.name} (${entry.ref} at ${entry.rev})`);
    try { renameSync(stage, target); }
    catch { if (!existsSync(target)) throw new Error(`cannot commit cache entry ${target}`); verifyTree(target, entry.narHash, `cached dependency ${entry.name}`); }
    return target;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
export async function resolveAndFetch(name: string, ref: string, explicitCache?: string) {
  const parsed = parseRef(ref);
  if (parsed.type === "path") fail(`path dependency ${name} does not resolve remotely`, "Use it directly without a lock entry.");
  const rev = await resolveRevision(parsed);
  const stage = join(cacheRoot(explicitCache), `.resolve-${randomUUID()}`);
  mkdirSync(dirname(stage), { recursive: true });
  try {
    await fetchTree(parsed, rev, stage);
    const entry = { name, ref, rev, narHash: narHash(stage) };
    const target = join(cacheRoot(explicitCache), cacheKey(entry.narHash));
    if (!existsSync(target)) renameSync(stage, target);
    else verifyTree(target, entry.narHash, `cached dependency ${name}`);
    return entry;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
function effectiveRoot(project: Project, requirement: Require, wholeTree: string) {
  const parsed = parseRef(requirement.ref);
  const root = parsed.type === "path" ? resolve(project.root, parsed.path) : parsed.subdir ? join(wholeTree, parsed.subdir) : wholeTree;
  const real = realpathSync(root);
  if (parsed.type === "path" && !isInside(project.sourceRoot, real)) fail(`path dependency ${requirement.name} escapes the source root`, `Choose a path inside ${project.sourceRoot}.`);
  return real;
}
export function cachedDependencyPaths(project: Project, overrides: Record<string, string> = {}, explicitCache?: string, entries = readLock(project.root, project.mod.requires.some((requirement) => !requirement.ref.startsWith("path:")))) {
  validateLock(project.mod, entries);
  const result: Record<string, string> = { ...overrides };
  for (const requirement of project.mod.requires) {
    if (result[requirement.name]) continue;
    const parsed = parseRef(requirement.ref);
    if (parsed.type === "path") result[requirement.name] = effectiveRoot(project, requirement, project.root);
    else {
      const entry = pinFor(project.mod, requirement, entries)!;
      const target = join(cacheRoot(explicitCache), cacheKey(entry.narHash));
      if (!existsSync(target)) fail(`dependency ${requirement.name} is locked but missing from the cache`, "Run skillful fetch; rendering and inspection never access the network.");
      verifyTree(target, entry.narHash, `cached dependency ${requirement.name} (${entry.ref} at ${entry.rev})`);
      result[requirement.name] = effectiveRoot(project, requirement, target);
    }
  }
  return result;
}
export async function dependencyPaths(project: Project, overrides: Record<string, string> = {}, explicitCache?: string) {
  const entries = readLock(project.root, project.mod.requires.some((requirement) => !requirement.ref.startsWith("path:")));
  validateLock(project.mod, entries);
  const result: Record<string, string> = { ...overrides };
  for (const requirement of project.mod.requires) {
    if (result[requirement.name]) continue;
    const parsed = parseRef(requirement.ref);
    if (parsed.type === "path") result[requirement.name] = effectiveRoot(project, requirement, project.root);
    else result[requirement.name] = effectiveRoot(project, requirement, await fetchEntry(pinFor(project.mod, requirement, entries)!, explicitCache));
  }
  return result;
}
function sameSelectors(requirement: Require, mode: "only" | "exclude" | undefined, selectors: string[]) { return requirement.mode === mode && [...requirement.selectors].sort().join("\0") === [...selectors].sort().join("\0"); }
function inferredDependencyName(parsed: ParsedRef) {
  const candidate = (parsed.type === "github"
    ? parsed.subdir?.split("/").at(-1) ?? parsed.repo
    : parsed.type === "git"
      ? parsed.subdir?.split("/").at(-1) ?? parsed.url.replace(/\/$/, "").split(/[/:]/).at(-1)?.replace(/\.git$/, "")
      : parsed.path.replace(/\/$/, "").split("/").at(-1))?.toLowerCase();
  if (!candidate || !/^[a-z0-9][a-z0-9._-]*$/.test(candidate)) fail(`cannot infer a dependency name from ${parsed.ref}`, "Pass --name using lowercase letters, digits, dots, underscores, or hyphens.");
  return candidate;
}
function transactionalWrite(project: Project, text: string, entries: LockEntry[], baselines?: Map<string, string>) {
  const modBefore = readFileSync(project.modPath, "utf8");
  try { writeFileSync(project.modPath, text); writeLockAtomic(project.root, entries, baselines); }
  catch (cause) {
    writeFileSync(project.modPath, modBefore);
    throw cause;
  }
}

export async function migrateProject(project: Project) {
  if (project.mod.version === 2) return undefined;
  const { resolveSkills } = await import("./contract.ts");
  const entries = readLock(project.root, false);
  const migrated = migrateMod(project.mod, project.modPath, () => resolveSkills(project, cachedDependencyPaths(project, {}, undefined, entries)));
  const refs = new Set(migrated.mod.requires.map(({ ref }) => ref));
  const pins = new Map<string, LockEntry>();
  for (const entry of entries) {
    if (!refs.has(entry.ref)) continue;
    const first = pins.get(entry.ref);
    if (!first) pins.set(entry.ref, entry);
    else if (first.rev !== entry.rev || first.narHash !== entry.narHash) fail(
      `cannot migrate ${entry.ref}: ${first.name} and ${entry.name} have different pins`,
      "Reconcile the alias pins before migrating, or keep using skillful 1.",
    );
  }
  const next = validateLock(migrated.mod, [...pins.values()]);
  if (next.length !== entries.length) transactionalWrite(project, migrated.text, next);
  else writeFileSync(project.modPath, migrated.text);
  return migrated;
}
function previousPin(mod: SkillMod, requirement: Require, entries: LockEntry[]) {
  const exact = pinFor(mod, requirement, entries);
  if (exact || mod.version === 1) return exact;
  const identity = parseRef(requirement.ref).identity;
  const unpinned = mod.requires.filter((candidate) => parseRef(candidate.ref).identity === identity && !pinFor(mod, candidate, entries));
  const orphaned = entries.filter((entry) => parseRef(entry.ref).identity === identity && !mod.requires.some(({ ref }) => ref === entry.ref));
  return unpinned.length === 1 && orphaned.length === 1 ? orphaned[0] : undefined;
}

async function overrideBaselines(project: Project, before: LockEntry[], after: LockEntry[], selected: Require[], cache?: string, full = false) {
  const previous = readOverrideBaselines(project.root);
  if (project.mod.version !== 2) return previous;
  const { mod } = project;
  const baselines = full ? new Map<string, string>() : new Map(previous);
  const items = mod.fieldOverrides.filter(({ operation }) => operation === "set");
  if (!items.length) return baselines;
  const { replacementKey, replacementHash } = await import("./contract.ts");
  for (const requirement of [undefined, ...selected]) {
    const origin = requirement?.name ?? "canonical";
    const applicable = items.filter(({ skill }) => requirement ? requirement.selectors.includes(skill) : !mod.requires.some(({ selectors }) => selectors.includes(skill)));
    if (!applicable.length) continue;
    const old = requirement && previousPin(mod, requirement, before);
    const next = requirement && pinFor(mod, requirement, after);
    let oldRoot: string | undefined;
    let nextRoot: string | undefined;
    for (const item of applicable) {
      const key = replacementKey(origin, item);
      const oldKey = old && replacementKey(old.ref, item);
      const hash = previous.get(key) ?? (oldKey && previous.get(oldKey));
      if (hash !== undefined) {
        if (oldKey && oldKey !== key) baselines.delete(oldKey);
        baselines.set(key, hash);
        continue;
      }
      if (requirement && old) oldRoot ??= effectiveRoot(project, requirement, await fetchEntry(old, cache));
      let file = oldRoot && join(oldRoot, item.skill, "SKILL.md");
      if (!file || !existsSync(file)) {
        nextRoot ??= !requirement ? resolveProjectPath(project, mod.roots.skills, "directory")
          : effectiveRoot(project, requirement, requirement.ref.startsWith("path:") ? project.root : await fetchEntry(next!, cache));
        file = join(nextRoot, item.skill, "SKILL.md");
      }
      if (existsSync(file)) baselines.set(key, replacementHash(readFileSync(file, "utf8"), item));
    }
  }
  return baselines;
}
function lockName(mod: SkillMod, requirement: Require, entries: LockEntry[]) {
  if (mod.version === 1) return requirement.name;
  return previousPin(mod, requirement, entries)?.name ?? `use-${createHash("sha256").update(requirement.ref).digest("hex")}`;
}

function namedRequirement(mod: SkillMod, name: string, entries: LockEntry[]) {
  const ref = mod.version === 2 ? entries.find((entry) => entry.name === name)?.ref : undefined;
  return mod.requires.find((requirement) => requirement.name === (ref ?? name));
}
export async function addDependency(project: Project, input: string, options: { name?: string | undefined; only?: string[] | undefined; exclude?: string[] | undefined; cache?: string | undefined } = {}) {
  if (options.only?.length && options.exclude?.length) fail("add cannot mix --only and --exclude", "Choose one selector mode.");
  const { mod } = project;
  if (mod.version === 2 && (options.name !== undefined || options.exclude !== undefined)) fail("skillful 2 use declarations do not take --name or --exclude", "Use a ref and name the skills with --only or edit the use directive.");
  const currentPins = mod.version === 2 ? readLock(project.root, false) : undefined;
  const named = namedRequirement(mod, input, currentPins ?? []);
  const parsedInput = parseRef(named?.ref ?? input);
  const omittedGitHubVersion = input.startsWith("github:") && !input.includes("@");
  const existing = named ?? mod.requires.find((requirement) => parseRef(requirement.ref).identity === parsedInput.identity);
  const ref = existing && (named !== undefined || omittedGitHubVersion) ? existing.ref : parsedInput.ref;
  const parsed = ref === parsedInput.ref ? parsedInput : parseRef(ref);
  const suppliedMode = options.only !== undefined ? "only" : options.exclude !== undefined ? "exclude" : undefined;
  const suppliedSelectors = options.only ?? options.exclude ?? [];
  const suppliedSelection = options.only !== undefined || options.exclude !== undefined;
  if (existing && (existing.ref !== ref
    || (options.name !== undefined && existing.name !== options.name)
    || (suppliedSelection && !sameSelectors(existing, suppliedMode, suppliedSelectors)))) {
    fail(`dependency ${existing.name} conflicts with the supplied add details`, "Omit version, --name, and selector flags to use skill.mod, or make supplied values match its declaration.");
  }
  if (!existing && mod.version === 2 && !options.only?.length) fail("a new use declaration needs named skills", "Pass --only for each skill, or declare use in skill.mod before locking it.");
  const name = existing?.name ?? (mod.version === 2 ? ref : options.name ?? inferredDependencyName(parsed));
  const requirement = existing ?? { ref, alias: mod.version === 2 ? undefined : options.name ?? name, name, mode: suppliedMode, selectors: [...suppliedSelectors], comments: [] };
  const nextMod = structuredClone(mod);
  if (!existing) nextMod.requires.push(requirement);
  if (parsed.type === "path") {
    effectiveRoot(project, requirement, project.root);
    const baselines = currentPins && await overrideBaselines({ ...project, mod: nextMod }, currentPins, currentPins, [requirement], options.cache);
    if (currentPins && baselines?.size) transactionalWrite(project, formatMod(nextMod), currentPins, baselines);
    else writeFileSync(project.modPath, formatMod(nextMod));
    return { requirement, entry: null };
  }
  const oldEntries = currentPins ?? readLock(project.root, false);
  const entry = await resolveAndFetch(lockName(mod, requirement, oldEntries), ref, options.cache);
  const next = [...oldEntries.filter((candidate) => candidate.name !== entry.name), entry];
  transactionalWrite(project, formatMod(nextMod), next, await overrideBaselines({ ...project, mod: nextMod }, oldEntries, next, [requirement], options.cache));
  return { requirement, entry };
}
export async function fetchDependencies(project: Project, names: string[] = [], cache?: string) {
  const selectedNames = [...new Set(names)];
  const hasRemote = project.mod.requires.some((requirement) => !requirement.ref.startsWith("path:"));
  const entries = readLock(project.root, selectedNames.length === 0 && hasRemote);
  let selected: LockEntry[];
  if (selectedNames.length === 0) {
    selected = validateLock(project.mod, entries);
  } else {
    selected = selectedNames.map((name) => {
      const requirement = namedRequirement(project.mod, name, entries);
      if (!requirement) fail(`unknown dependency ${name}`, "Choose a dependency declared in skill.mod.");
      if (requirement.ref.startsWith("path:")) fail(`path dependency ${name} has no pin to fetch`, "Use the local tree directly.");
      const entry = pinFor(project.mod, requirement, entries);
      if (!entry) fail(`dependency ${name} is declared but not locked`, `Run skillful update ${name}.`);
      if (entry.ref !== requirement.ref) fail(`dependency ${name} changed from locked ref ${entry.ref} to ${requirement.ref}`, `Run skillful update ${name} to move the pin.`);
      return entry;
    });
  }
  for (const entry of selected) await fetchEntry(entry, cache);
  return selected;
}

export async function updateDependencies(project: Project, names: string[], cache?: string) {
  const selectedNames = [...new Set(names)];
  const existing = readLock(project.root, false);
  const remote = project.mod.requires.filter((requirement) => !requirement.ref.startsWith("path:"));
  const selected = selectedNames.length === 0 ? remote : selectedNames.map((name) => {
    const requirement = namedRequirement(project.mod, name, existing) ?? remote.find((candidate) => previousPin(project.mod, candidate, existing)?.name === name);
    if (!requirement) fail(`unknown dependency ${name}`, "Choose a dependency declared in skill.mod.");
    if (requirement.ref.startsWith("path:")) fail(`path dependency ${name} has no pin to update`, "Edit the local tree directly.");
    return requirement;
  });
  const refreshed: LockEntry[] = [];
  for (const requirement of new Set(selected)) refreshed.push(await resolveAndFetch(lockName(project.mod, requirement, existing), requirement.ref, cache));
  const selectedSet = new Set(refreshed.map((entry) => entry.name));
  const next = [...(selectedNames.length === 0 ? [] : existing.filter((entry) => !selectedSet.has(entry.name))), ...refreshed];
  const full = selectedNames.length === 0;
  if (full && project.mod.version === 2) {
    const { resolveSkills } = await import("./contract.ts");
    resolveSkills(project, cachedDependencyPaths(project, {}, cache, next));
  }
  writeLockAtomic(project.root, next, await overrideBaselines(project, existing, next, full ? project.mod.requires : [...new Set(selected)], cache, full));
  return next;
}
