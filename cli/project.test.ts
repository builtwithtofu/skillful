import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProject, initProject, ProjectError } from "./project.ts";

const dirs: string[] = [];
const temp = () => {
  const path = join(tmpdir(), `skillful-project-${crypto.randomUUID()}`);
  mkdirSync(path, { recursive: true });
  dirs.push(path);
  return path;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("project discovery", () => {
  test("uses the nearest ancestor skill.mod", () => {
    const root = temp();
    const outer = join(root, "outer");
    const inner = join(outer, "inner");
    mkdirSync(join(inner, "nested"), { recursive: true });
    writeFileSync(join(outer, "skill.mod"), "skillful 1\n");
    writeFileSync(join(inner, "skill.mod"), "skillful 1\nskills ./local\n");
    expect(discoverProject({ cwd: join(inner, "nested") }).root).toBe(inner);
  });

  test("--project overrides discovery and requires a manifest", () => {
    const root = temp();
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(join(project, "skill.mod"), "skillful 1\n");
    expect(discoverProject({ cwd: root, project }).root).toBe(project);
    expect(() => discoverProject({ cwd: root, project: join(root, "missing") })).toThrow(ProjectError);
  });

  test("missing project teaches init and --project", () => {
    const root = temp();
    try { discoverProject({ cwd: root }); } catch (error) {
      expect(error).toBeInstanceOf(ProjectError);
      expect((error as ProjectError).message).toContain("skillful init");
      expect((error as ProjectError).message).toContain("--project");
    }
  });
});

describe("init", () => {
  test("creates the shared scaffold and refuses unrelated non-empty destinations", () => {
    const destination = join(temp(), "new-project");
    initProject(destination);
    expect(readFileSync(join(destination, "skill.mod"), "utf8")).toBe(readFileSync(join(import.meta.dir, "..", "templates", "basic", "skill.mod"), "utf8"));
    expect(existsSync(join(destination, "skills", "example", "SKILL.md"))).toBe(true);
    expect(existsSync(join(destination, "rules", "global_agents.md"))).toBe(true);
    expect(existsSync(join(destination, "project.nix"))).toBe(false);

    const nonEmpty = temp();
    writeFileSync(join(nonEmpty, "notes.txt"), "keep me");
    expect(() => initProject(nonEmpty)).toThrow(ProjectError);

    const emptyNestedDirectory = join(temp(), "empty-directory");
    mkdirSync(join(emptyNestedDirectory, "keep"), { recursive: true });
    expect(() => initProject(emptyNestedDirectory)).toThrow(ProjectError);
  });

  test("accepts only a compatible already-generated scaffold", () => {
    const destination = join(temp(), "project");
    initProject(destination);
    initProject(destination);
  });
});
