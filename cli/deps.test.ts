import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
    expect(parseRef("github:Owner/Repo").ref).toBe("github:Owner/Repo@HEAD");
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

  test("infers a stable dependency name when adding a new tree", async () => {
    const { project, ref, cache } = fixture();
    const result = await addDependency(discoverProject({ project }), ref, { cache });
    expect(result.requirement.name).toBe("dependency");
    expect(readFileSync(join(project, "skill.mod"), "utf8")).toContain(`require ${JSON.stringify(ref)} as dependency`);
    expect(readLock(project)[0]?.name).toBe("dependency");
  });

  test("locks an existing declaration by name and preserves its choices", async () => {
    const { project, ref, cache } = fixture();
    const modPath = join(project, "skill.mod");
    writeFileSync(modPath, formatText(`${readFileSync(modPath, "utf8")}\nrequire ${JSON.stringify(ref)} as dep (\n  only skill-a\n)\n`));
    const before = readFileSync(modPath, "utf8");

    await addDependency(discoverProject({ project }), "dep", { cache });

    expect(readFileSync(modPath, "utf8")).toBe(before);
    expect(readLock(project)[0]?.name).toBe("dep");
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
    await fetchDependencies(discoverProject({ project }), [], fresh);
    expect(readFileSync(join(project, "skill.lock"), "utf8")).toBe(lockBefore);
    const cacheRoot = join(fresh, "skillful");
    const entryDir = join(cacheRoot, readdirSync(cacheRoot).find((name) => !name.startsWith("."))!);
    writeFileSync(join(entryDir, "skill-a", "SKILL.md"), "tampered");
    await expect(fetchDependencies(discoverProject({ project }), [], fresh)).rejects.toThrow("hash mismatch");
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

  test("add writes a use declaration for named skills without changing the manifest version", async () => {
    const { project, ref, cache } = fixture();
    const mod = join(project, "skill.mod");
    writeFileSync(mod, "skillful 2\nagents pi\n");

    await addDependency(discoverProject({ project }), ref, { only: ["skill-b"], cache });
    expect(readFileSync(mod, "utf8")).toStartWith("skillful 2\n");
    expect(readFileSync(mod, "utf8")).toContain(`use ${ref} { skill-b }`);
    expect(readLock(project)[0]?.ref).toBe(ref);
  });
  test("add refuses a conflicting second ref for an existing source", async () => {
    const { project, ref, cache } = fixture();
    const modPath = join(project, "skill.mod");
    writeFileSync(modPath, "skillful 2\nagents pi\n");
    await addDependency(discoverProject({ project }), ref, { only: ["skill-a"], cache });
    const before = readFileSync(modPath, "utf8");
    const pins = readLock(project);
    await expect(addDependency(discoverProject({ project }), ref.replace(/@main$/, "@HEAD"), { only: ["skill-a"], cache })).rejects.toThrow("conflicts");
    expect(readFileSync(modPath, "utf8")).toBe(before);
    expect(readLock(project)).toEqual(pins);
  });

  test("targeted update replaces an old pin when a use changes ref", async () => {
    const { project, ref, cache, dependency } = fixture();
    const modPath = join(project, "skill.mod");
    const manifest = (source: string) => `skillful 2\nuse ${source} { skill-a }\nagents pi\n`;
    writeFileSync(modPath, manifest(ref));
    await updateDependencies(discoverProject({ project }), [], cache);
    git(dependency, "branch", "next");
    const next = ref.replace(/@main$/, "@next");
    writeFileSync(modPath, manifest(next));
    await updateDependencies(discoverProject({ project }), [next], cache);
    expect(readLock(project).map(({ ref }) => ref)).toEqual([next]);
    expect(cachedDependencyPaths(discoverProject({ project }), {}, cache)[next]).toBeDefined();
  });

  test.each(["existing pin", "targeted update", "changed ref", "add"] as const)("check sees drift against the prior source after %s", async (mode) => {
    const { project, ref, cache, dependency } = fixture();
    const modPath = join(project, "skill.mod");
    const manifest = (source: string, override = true) => `skillful 2\nuse ${source} { skill-a }\nagents pi\n${override ? 'skill-a.body = "Project guidance"\nskill-a.description = "Project description"\n' : ""}`;
    writeFileSync(join(project, "skills", "example", "SKILL.md"), "Example instructions.\n");
    writeFileSync(modPath, manifest(ref, mode !== "existing pin"));
    if (mode === "add") await addDependency(discoverProject({ project }), ref, { cache });
    else await updateDependencies(discoverProject({ project }), mode === "targeted update" ? [ref] : [], cache);
    if (mode === "existing pin") writeFileSync(modPath, manifest(ref));
    const check = () => Bun.spawnSync(["bun", join(import.meta.dir, "main.ts"), "check", "--strict"], {
      cwd: project, env: { ...process.env, XDG_CACHE_HOME: cache }, stdout: "pipe", stderr: "pipe",
    });
    expect(check().exitCode).toBe(0);
    writeFileSync(join(dependency, "skill-a", "SKILL.md"), "---\nname: skill-a\ndescription: New upstream description\n---\nNew upstream guidance.\n");
    git(dependency, "add", ".");
    git(dependency, "commit", "-m", "change upstream description and body");
    if (mode === "changed ref") {
      git(dependency, "branch", "next");
      writeFileSync(modPath, manifest(ref.replace(/@main$/, "@next")));
    }
    if (mode === "add") await addDependency(discoverProject({ project }), ref, { cache });
    else await updateDependencies(discoverProject({ project }), mode === "targeted update" ? [ref] : [], cache);
    const result = check();
    expect(result.stdout.toString() + result.stderr.toString()).toContain("upstream changed skill-a.body");
    expect(result.stdout.toString() + result.stderr.toString()).toContain("upstream changed skill-a.description");
    expect(result.exitCode).toBe(1);
  });
  test.each([false, true])("skillful 2 updates and fetches use refs (existing pin: %s)", async (existingPin) => {
    const { root, project, dependency, ref, cache } = fixture();
    if (existingPin) await addDependency(discoverProject({ project }), ref, { name: "legacy-alias", cache });
    const mod = join(project, "skill.mod");
    const v2 = `skillful 2\nuse ${ref} { skill-a }\nagents pi\n`;
    writeFileSync(mod, v2);
    const current = discoverProject({ project });
    const lock = join(project, "skill.lock");
    if (existingPin) expect(existsSync(join(cachedDependencyPaths(current, {}, cache)[ref]!, "skill-a", "SKILL.md"))).toBe(true);
    writeFileSync(join(dependency, "skill-a", "new.txt"), "updated\n");
    git(dependency, "add", ".");
    git(dependency, "commit", "-m", "move branch");

    await updateDependencies(current, [ref], cache);
    const updatedPin = readLock(project);
    expect(updatedPin).toHaveLength(1);
    expect(updatedPin[0]).toMatchObject({ ref, rev: git(dependency, "rev-parse", "HEAD") });
    const pinned = readFileSync(lock, "utf8");
    const fresh = join(root, "fresh-cache");
    await fetchDependencies(current, [ref], fresh);
    const source = cachedDependencyPaths(current, {}, fresh)[ref]!;
    expect(readFileSync(join(source, "skill-a", "new.txt"), "utf8")).toBe("updated\n");
    expect(readFileSync(mod, "utf8")).toBe(v2);
    expect(readFileSync(lock, "utf8")).toBe(pinned);
  });
  test("updates one declared dependency without requiring unrelated pins", async () => {
    const { root, project, ref, cache } = fixture();
    const modPath = join(project, "skill.mod");
    writeFileSync(modPath, formatText(`${readFileSync(modPath, "utf8")}\nrequire ${JSON.stringify(ref)} as dep\nrequire ${JSON.stringify(ref.replace(/@main$/, "@missing"))} as later\n`));
    const before = readFileSync(modPath, "utf8");

    await updateDependencies(discoverProject({ project }), ["dep"], cache);

    expect(readFileSync(modPath, "utf8")).toBe(before);
    expect(readLock(project).map((entry) => entry.name)).toEqual(["dep"]);
    const lockBefore = readFileSync(join(project, "skill.lock"), "utf8");
    await fetchDependencies(discoverProject({ project }), ["dep"], join(root, "fresh-cache"));
    expect(readFileSync(join(project, "skill.lock"), "utf8")).toBe(lockBefore);
    await expect(updateDependencies(discoverProject({ project }), [], cache)).rejects.toThrow();
    expect(readFileSync(join(project, "skill.lock"), "utf8")).toBe(lockBefore);
  });

  test("uses a sibling path dependency from the source workspace", async () => {
    const { root, project, dependency } = fixture();
    git(root, "init", "-b", "main");

    await addDependency(discoverProject({ project }), "path:../dependency", { name: "local" });

    expect(existsSync(join(project, "skill.lock"))).toBe(false);
    expect(cachedDependencyPaths(discoverProject({ project })).local).toBe(realpathSync(dependency));
    const before = readFileSync(join(project, "skill.mod"), "utf8");
    await expect(addDependency(discoverProject({ project }), "path:../..", { name: "outside" })).rejects.toThrow("escapes the source root");
    expect(readFileSync(join(project, "skill.mod"), "utf8")).toBe(before);
  });

  test("does not treat a remote override as its fallback lock", () => {
    const { project, dependency, ref, cache } = fixture();
    const modPath = join(project, "skill.mod");
    writeFileSync(modPath, formatText(`${readFileSync(modPath, "utf8")}\nrequire ${JSON.stringify(ref)} as dep\n`));
    writeFileSync(join(project, "skill.lock"), "");

    expect(() => cachedDependencyPaths(discoverProject({ project }), { dep: dependency }, cache)).toThrow("declared but not locked");
  });
});
