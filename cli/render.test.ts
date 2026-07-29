import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverProject } from "./project.ts";
import { commitStagedTree, renderProject, RenderOutputError } from "./render.ts";
import { contractFor, resolvePlan } from "./contract.ts";
import { copyBasicFixture } from "./test-fixture.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "skillful-render-test-"));
  roots.push(root);
  const project = join(root, "project");
  copyBasicFixture(project);
  return { root, project, resolved: discoverProject({ project }) };
}
function text(path: string) { return readFileSync(path, "utf8"); }

describe("TypeScript renderer", () => {
  test("shares one plan across contract and rendered skills, commands, rules, and support files", () => {
    const { project, resolved } = fixture();
    const plan = resolvePlan(resolved);
    const contract = contractFor(plan);
    expect(contract.schemaVersion).toBe(1);
    expect(contract.manifest.harnesses.pi.assets).toEqual([]);
    expect(contract.manifest.harnesses.pi.skills.map((skill) => skill.name)).toContain("example");

    renderProject(resolved);
    const claude = text(join(project, "rendered", "claude", "skills", "example", "SKILL.md"));
    expect(claude).toContain("Claude Code");
    expect(claude).toContain("Claude keeps this line.");
    expect(claude).not.toContain("Other harnesses keep this line.");
    expect(claude).toContain("$ARGUMENTS");
    expect(claude.indexOf("Use the example skill with:")).toBeLessThan(claude.indexOf("# Example"));
    expect(claude).toContain("argument-hint: [input]");
    expect(existsSync(join(project, "rendered", "claude", "commands", "example.md"))).toBe(false);

    const pi = text(join(project, "rendered", "pi", "skills", "example", "SKILL.md"));
    expect(pi).toContain("Pi");
    expect(pi).toContain("Other harnesses keep this line.");
    expect(pi).not.toContain("Claude keeps this line.");
    expect(pi).toContain("Arguments: $@");
    expect(text(join(project, "rendered", "pi", "commands", "example.md"))).toContain("Use the `example` skill.");
    expect(text(join(project, "rendered", "pi", "rules.md"))).toContain("This line demonstrates rules rendering.");
    expect(text(join(project, "rendered", "pi", "skills", "example", "references", "guide.md"))).toContain("copied without rendering");
  });

  test("rejects unresolved markup before touching an existing output", () => {
    const { project, resolved } = fixture();
    renderProject(resolved, { harnesses: ["pi"] });
    const before = text(join(project, "rendered", "pi", "skills", "example", "SKILL.md"));
    writeFileSync(join(project, "skills", "example", "SKILL.md"), "---\nname: example\n---\n{{missing}}\n");
    expect(() => renderProject(discoverProject({ project }), { harnesses: ["pi"] })).toThrow("unresolved {{missing}}");
    expect(text(join(project, "rendered", "pi", "skills", "example", "SKILL.md"))).toBe(before);
  });

  test("dry-run writes nothing and managed rerenders remove stale support files", () => {
    const { project, resolved } = fixture();
    const dry = renderProject(resolved, { harnesses: ["pi"], dryRun: true });
    expect(dry.changes.length).toBeGreaterThan(0);
    expect(existsSync(join(project, "rendered"))).toBe(false);
    renderProject(resolved, { harnesses: ["pi"] });
    rmSync(join(project, "skills", "example", "references", "guide.md"));
    const result = renderProject(discoverProject({ project }), { harnesses: ["pi"] });
    expect(result.changes).toContainEqual({ path: "pi/skills/example/references/guide.md", action: "delete" });
    expect(existsSync(join(project, "rendered", "pi", "skills", "example", "references", "guide.md"))).toBe(false);
  });

  test("refuses unmanaged and edited output unless force is explicit", () => {
    const { project, resolved } = fixture();
    mkdirSync(join(project, "rendered"));
    writeFileSync(join(project, "rendered", "notes.txt"), "mine");
    expect(() => renderProject(resolved, { harnesses: ["pi"] })).toThrow("unmanaged");
    renderProject(resolved, { harnesses: ["pi"], force: true });
    const managed = join(project, "rendered", "pi", "skills", "example", "SKILL.md");
    writeFileSync(managed, "edited");
    expect(() => renderProject(resolved, { harnesses: ["pi"] })).toThrow("was modified");
    renderProject(resolved, { harnesses: ["pi"], force: true });
    expect(text(managed)).not.toBe("edited");
  });

  test("duplicate delivered names report both origins", () => {
    const { project } = fixture();
    const dep = join(project, "dep");
    mkdirSync(join(dep, "example"), { recursive: true });
    writeFileSync(join(dep, "example", "SKILL.md"), "---\nname: example\ndescription: duplicate\n---\n");
    writeFileSync(join(project, "skill.mod"), `${text(join(project, "skill.mod"))}\nrequire path:dep as dependency\n`);
    expect(() => resolvePlan(discoverProject({ project }))).toThrow("example (canonical, dependency)");
  });
});

describe("render tree commit recovery", () => {
  test("restores the previous tree when installing the staged tree fails", () => {
    const root = mkdtempSync(join(tmpdir(), "skillful-commit-test-"));
    roots.push(root);
    const target = join(root, "rendered");
    const stage = join(root, "stage");
    mkdirSync(target); mkdirSync(stage);
    writeFileSync(join(target, "old"), "old");
    writeFileSync(join(stage, "new"), "new");
    let renames = 0;
    expect(() => commitStagedTree(stage, target, {
      renameSync(from, to) { renames++; if (renames === 2) throw new Error("injected install failure"); return renameSync(from, to); },
      rmSync,
    })).toThrow("injected install failure");
    expect(text(join(target, "old"))).toBe("old");
    expect(existsSync(join(target, "new"))).toBe(false);
  });

  test("retains recoverable paths when restoration also fails", () => {
    const root = mkdtempSync(join(tmpdir(), "skillful-commit-test-"));
    roots.push(root);
    const target = join(root, "rendered");
    const stage = join(root, "stage");
    mkdirSync(target); mkdirSync(stage);
    let renames = 0;
    expect(() => commitStagedTree(stage, target, {
      renameSync() { renames++; if (renames >= 2) throw new Error(`failure ${renames}`); },
      rmSync,
    })).toThrow(RenderOutputError);
    expect(existsSync(stage)).toBe(true);
  });
});
