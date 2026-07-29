import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { cacheKey, narHash } from "./nar.ts";
import { readLock, validateLock, writeLockAtomic, type LockEntry } from "./lock.ts";
import { formatMod, type Require, type SkillMod } from "./mod.ts";
import type { Project } from "./project.ts";

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
    if (path.startsWith("/") || path.split("/").includes("..")) fail(`path dependency escapes the project: ${path}`, "Use a relative path inside the project root.");
    return { type: "path", ref, identity: `path:${path.replace(/\/$/, "")}`, path };
  }
  if (ref.startsWith("github:")) {
    const at = ref.lastIndexOf("@");
    if (at <= "github:".length || at === ref.length - 1) fail(`GitHub ref needs @version: ${ref}`, "Use github:owner/repo[/subdir]@tag-or-revision.");
    const path = ref.slice("github:".length, at);
    const parts = path.split("/");
    if (parts.length < 2 || parts.some((part) => !part || part === "." || part === "..")) fail(`invalid GitHub ref: ${ref}`, "Use github:owner/repo[/subdir]@version.");
    const [owner, repo, ...rest] = parts;
    const subdir = validateSubdir(rest.length ? rest.join("/") : undefined);
    const identity = `github:${owner!.toLowerCase()}/${repo!.toLowerCase()}${subdir ? `/${subdir}` : ""}`;
    return { type: "github", ref, identity, owner: owner!, repo: repo!, subdir, version: ref.slice(at + 1) };
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
  if (parsed.type === "path") {
    const rel = relative(project.root, real);
    if (!rel || rel === ".." || rel.startsWith("../")) fail(`path dependency ${requirement.name} escapes the project`, "Use a path inside the project root.");
  }
  return real;
}
export function cachedDependencyPaths(project: Project, overrides: Record<string, string> = {}, explicitCache?: string) {
  const overridden = new Set(Object.keys(overrides));
  const needsLock = project.mod.requires.some((requirement) => !requirement.ref.startsWith("path:") && !overridden.has(requirement.name));
  const entries = validateLock(project.mod, readLock(project.root, needsLock), overridden);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const result: Record<string, string> = { ...overrides };
  for (const requirement of project.mod.requires) {
    if (result[requirement.name]) continue;
    const parsed = parseRef(requirement.ref);
    if (parsed.type === "path") result[requirement.name] = effectiveRoot(project, requirement, project.root);
    else {
      const entry = byName.get(requirement.name)!;
      const target = join(cacheRoot(explicitCache), cacheKey(entry.narHash));
      if (!existsSync(target)) fail(`dependency ${requirement.name} is locked but missing from the cache`, "Run skillful fetch; rendering and inspection never access the network.");
      verifyTree(target, entry.narHash, `cached dependency ${requirement.name} (${entry.ref} at ${entry.rev})`);
      result[requirement.name] = effectiveRoot(project, requirement, target);
    }
  }
  return result;
}
export async function dependencyPaths(project: Project, overrides: Record<string, string> = {}, explicitCache?: string) {
  const overridden = new Set(Object.keys(overrides));
  const entries = readLock(project.root, project.mod.requires.some((requirement) => !requirement.ref.startsWith("path:") && !overridden.has(requirement.name)));
  validateLock(project.mod, entries, overridden);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const result: Record<string, string> = { ...overrides };
  for (const requirement of project.mod.requires) {
    if (result[requirement.name]) continue;
    const parsed = parseRef(requirement.ref);
    if (parsed.type === "path") result[requirement.name] = effectiveRoot(project, requirement, project.root);
    else result[requirement.name] = effectiveRoot(project, requirement, await fetchEntry(byName.get(requirement.name)!, explicitCache));
  }
  return result;
}
function sameSelectors(requirement: Require, mode: "only" | "exclude" | undefined, selectors: string[]) { return requirement.mode === mode && [...requirement.selectors].sort().join("\0") === [...selectors].sort().join("\0"); }
function transactionalWrite(project: Project, mod: SkillMod, entries: LockEntry[]) {
  const modBefore = readFileSync(project.modPath, "utf8");
  const lockPath = join(project.root, "skill.lock");
  const lockBefore = existsSync(lockPath) ? readFileSync(lockPath, "utf8") : null;
  try { writeFileSync(project.modPath, formatMod(mod)); writeLockAtomic(project.root, entries); }
  catch (cause) {
    writeFileSync(project.modPath, modBefore);
    if (lockBefore === null) rmSync(lockPath, { force: true }); else writeFileSync(lockPath, lockBefore);
    throw cause;
  }
}
export async function addDependency(project: Project, ref: string, options: { name?: string | undefined; only?: string[] | undefined; exclude?: string[] | undefined; cache?: string | undefined } = {}) {
  const parsed = parseRef(ref);
  if (options.only?.length && options.exclude?.length) fail("add cannot mix --only and --exclude", "Choose one selector mode.");
  const alias = options.name;
  const name = alias ?? parsed.identity;
  const mode = options.only?.length ? "only" : options.exclude?.length ? "exclude" : undefined;
  const selectors = options.only ?? options.exclude ?? [];
  const existing = project.mod.requires.find((requirement) => requirement.name === name || parseRef(requirement.ref).identity === parsed.identity);
  if (existing && (existing.ref !== ref || !sameSelectors(existing, mode, selectors) || existing.name !== name)) fail(`dependency ${name} conflicts with an existing require`, "Use the existing alias and exact selector set, or edit skill.mod deliberately before retrying.");
  const requirement = existing ?? { ref, alias, name, mode, selectors: [...selectors], comments: [] };
  const mod = structuredClone(project.mod);
  if (!existing) mod.requires.push(requirement);
  if (parsed.type === "path") { writeFileSync(project.modPath, formatMod(mod)); return { requirement, entry: null }; }
  const entry = await resolveAndFetch(name, ref, options.cache);
  const oldEntries = readLock(project.root, false).filter((candidate) => candidate.name !== name);
  transactionalWrite(project, mod, [...oldEntries, entry]);
  return { requirement, entry };
}
export async function fetchDependencies(project: Project, cache?: string, overridden = new Set<string>()) {
  const entries = validateLock(project.mod, readLock(project.root), overridden);
  for (const entry of entries) await fetchEntry(entry, cache);
  return entries;
}
export async function updateDependencies(project: Project, names: string[], cache?: string, overridden = new Set<string>()) {
  const entries = validateLock(project.mod, readLock(project.root), overridden);
  const selected = names.length ? new Set(names) : new Set(entries.map((entry) => entry.name));
  for (const name of selected) if (!entries.some((entry) => entry.name === name)) fail(`unknown locked dependency ${name}`, "Run skillful list skills or inspect skill.lock for valid names.");
  const next: LockEntry[] = [];
  for (const entry of entries) next.push(selected.has(entry.name) ? await resolveAndFetch(entry.name, entry.ref, cache) : entry);
  writeLockAtomic(project.root, next);
  return next;
}
