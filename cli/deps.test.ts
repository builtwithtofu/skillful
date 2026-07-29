import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addDependency, cachedDependencyPaths, fetchDependencies, parseRef, updateDependencies } from "./deps.ts";
import { readLock } from "./lock.ts";
import { formatText } from "./mod.ts";
import { discoverProject } from "./project.ts";
import { copyBasicFixture } from "./test-fixture.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "skillful-deps-test-"));
  roots.push(root);
  const project = join(root, "project");
  const dependency = join(root, "dependency");
  const cache = join(root, "cache");
  copyBasicFixture(project);
  mkdirSync(join(dependency, "skill-a"), { recursive: true });
  mkdirSync(join(dependency, "skill-b"), { recursive: true });
  writeFileSync(join(dependency, "skill-a", "SKILL.md"), "---\nname: skill-a\ndescription: A\n---\n");
  writeFileSync(join(dependency, "skill-b", "SKILL.md"), "---\nname: skill-b\ndescription: B\n---\n");
  git(dependency, "init", "-b", "main");
  git(dependency, "config", "user.email", "test@example.invalid");
  git(dependency, "config", "user.name", "Test");
  git(dependency, "add", ".");
  git(dependency, "commit", "-m", "initial");
  return { root, project, dependency, cache, ref: `git:file://${dependency}@main` };
}

describe("dependency references", () => {
  test("parses canonical GitHub, Git, and path identities", () => {
    expect(parseRef("github:Owner/Repo/skills@main").identity).toBe("github:owner/repo/skills");
    expect(parseRef("git:ssh://git@example.com/repo.git@main#skills").identity).toBe("git:ssh://git@example.com/repo.git#skills");
    expect(parseRef("path:fixtures/dependency").type).toBe("path");
    expect(() => parseRef("https://example.com/repo")).toThrow("unsupported");
    expect(() => parseRef("git:https://user:secret@example.com/repo@main")).toThrow("credential-bearing");
  });
});

describe("dependency transactions and cache", () => {
  test("add resolves, locks, fetches, and applies selectors", async () => {
    const { project, ref, cache } = fixture();
    const result = await addDependency(discoverProject({ project }), ref, { name: "dep", only: ["skill-a"], cache });
    expect(result.entry?.rev).toHaveLength(40);
    expect(readFileSync(join(project, "skill.mod"), "utf8")).toContain(`require ${JSON.stringify(ref)} as dep`);
    expect(readLock(project)).toHaveLength(1);
    const paths = cachedDependencyPaths(discoverProject({ project }), {}, cache);
    expect(existsSync(join(paths.dep!, "skill-a", "SKILL.md"))).toBe(true);
    expect(existsSync(join(paths.dep!, "skill-b", "SKILL.md"))).toBe(true);
  });

  test("adopts an exact unlocked declaration and rejects conflicting adoption", async () => {
    const { project, ref, cache } = fixture();
    const modPath = join(project, "skill.mod");
    writeFileSync(modPath, formatText(`${readFileSync(modPath, "utf8")}\nrequire ${JSON.stringify(ref)} as dep (\n  only skill-a\n)\n`));
    await addDependency(discoverProject({ project }), ref, { name: "dep", only: ["skill-a"], cache });
    expect((readFileSync(modPath, "utf8").match(/require /g) ?? [])).toHaveLength(1);
    await expect(addDependency(discoverProject({ project }), ref, { name: "dep", only: ["skill-b"], cache })).rejects.toThrow("conflicts");
  });

  test("failed resolution leaves manifest and lock untouched", async () => {
    const { project, dependency, cache } = fixture();
    const modPath = join(project, "skill.mod");
    const before = readFileSync(modPath, "utf8");
    await expect(addDependency(discoverProject({ project }), `git:file://${dependency}@missing`, { name: "dep", cache })).rejects.toThrow();
    expect(readFileSync(modPath, "utf8")).toBe(before);
    expect(existsSync(join(project, "skill.lock"))).toBe(false);
  });

  test("fetch repairs a fresh cache without moving pins and detects tampering", async () => {
    const { root, project, ref, cache } = fixture();
    await addDependency(discoverProject({ project }), ref, { name: "dep", cache });
    const lockBefore = readFileSync(join(project, "skill.lock"), "utf8");
    const fresh = join(root, "fresh-cache");
    await fetchDependencies(discoverProject({ project }), fresh);
    expect(readFileSync(join(project, "skill.lock"), "utf8")).toBe(lockBefore);
    const cacheRoot = join(fresh, "skillful");
    const entryDir = join(cacheRoot, readdirSync(cacheRoot).find((name) => !name.startsWith("."))!);
    writeFileSync(join(entryDir, "skill-a", "SKILL.md"), "tampered");
    await expect(fetchDependencies(discoverProject({ project }), fresh)).rejects.toThrow("hash mismatch");
  });

  test("update moves a branch pin and fetches the new tree", async () => {
    const { project, dependency, ref, cache } = fixture();
    await addDependency(discoverProject({ project }), ref, { name: "dep", cache });
    const oldRev = readLock(project)[0]!.rev;
    writeFileSync(join(dependency, "skill-a", "new.txt"), "new\n");
    git(dependency, "add", ".");
    git(dependency, "commit", "-m", "move branch");
    await updateDependencies(discoverProject({ project }), ["dep"], cache);
    expect(readLock(project)[0]!.rev).not.toBe(oldRev);
  });

  test("path dependencies update only the manifest", async () => {
    const { project } = fixture();
    mkdirSync(join(project, "local", "local-skill"), { recursive: true });
    writeFileSync(join(project, "local", "local-skill", "SKILL.md"), "---\nname: local-skill\n---\n");
    await addDependency(discoverProject({ project }), "path:local", { name: "local" });
    expect(existsSync(join(project, "skill.lock"))).toBe(false);
    expect(cachedDependencyPaths(discoverProject({ project })).local).toBe(join(project, "local"));
  });
});
