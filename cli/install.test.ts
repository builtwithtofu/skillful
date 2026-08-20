import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { installProject } from "./install.ts";
import { discoverProject } from "./project.ts";
import { copyBasicFixture } from "./test-fixture.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "skillful-install-test-"));
  roots.push(root);
  const project = join(root, "project");
  const home = join(root, "home");
  const otherHome = join(root, "other-home");
  const state = join(root, "state");
  copyBasicFixture(project);
  mkdirSync(home); mkdirSync(otherHome); mkdirSync(state);
  return { root, project, home, otherHome, state };
}

describe("safe installation", () => {
  test("dry-run changes nothing, first install writes state, and rerun is idempotent", () => {
    const { project, home, state } = fixture();
    const resolved = discoverProject({ project });
    const dry = installProject(resolved, { harness: "pi", root: home, stateHome: state, dryRun: true });
    expect(dry.changes.length).toBeGreaterThan(0);
    expect(existsSync(join(home, ".pi"))).toBe(false);
    expect(existsSync(dry.statePath)).toBe(false);

    const first = installProject(resolved, { harness: "pi", root: home, stateHome: state });
    expect(existsSync(join(home, ".pi", "agent", "skills", "example", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".pi", "agent", "prompts", "example.md"))).toBe(true);
    expect(existsSync(join(home, ".pi", "agent", "AGENTS.md"))).toBe(true);
    expect(existsSync(first.statePath)).toBe(true);
    expect(installProject(resolved, { harness: "pi", root: home, stateHome: state }).changes).toEqual([]);
  });

  test("removes stale owned files without touching another destination root", () => {
    const { project, home, otherHome, state } = fixture();
    const resolved = discoverProject({ project });
    const first = installProject(resolved, { harness: "pi", root: home, stateHome: state });
    const second = installProject(resolved, { harness: "pi", root: otherHome, stateHome: state });
    expect(first.statePath).not.toBe(second.statePath);
    rmSync(join(project, "skills", "hidden"), { recursive: true });
    const changed = installProject(discoverProject({ project }), { harness: "pi", root: home, stateHome: state });
    expect(changed.changes).toContainEqual({ path: ".pi/agent/skills/hidden/SKILL.md", action: "delete" });
    expect(existsSync(join(home, ".pi", "agent", "skills", "hidden", "SKILL.md"))).toBe(false);
    expect(existsSync(join(otherHome, ".pi", "agent", "skills", "hidden", "SKILL.md"))).toBe(true);
  });

  test("refuses modified owned and unmanaged files unless force is explicit", () => {
    const { project, home, state } = fixture();
    const resolved = discoverProject({ project });
    installProject(resolved, { harness: "pi", root: home, stateHome: state });
    const owned = join(home, ".pi", "agent", "skills", "example", "SKILL.md");
    writeFileSync(owned, "mine");
    expect(() => installProject(resolved, { harness: "pi", root: home, stateHome: state })).toThrow("was modified");
    installProject(resolved, { harness: "pi", root: home, stateHome: state, force: true });
    expect(readFileSync(owned, "utf8")).not.toBe("mine");

    const fresh = join(home, ".config", "opencode", "skills", "example", "SKILL.md");
    mkdirSync(join(fresh, ".."), { recursive: true });
    writeFileSync(fresh, "unmanaged");
    expect(() => installProject(resolved, { harness: "opencode", root: home, stateHome: state })).toThrow("unmanaged installation collision");
    installProject(resolved, { harness: "opencode", root: home, stateHome: state, force: true });
    expect(readFileSync(fresh, "utf8")).not.toBe("unmanaged");
  });
  test("never deletes a modified stale file, even with force", () => {
    const { project, home, state } = fixture();
    const resolved = discoverProject({ project });
    installProject(resolved, { harness: "pi", root: home, stateHome: state });
    const stale = join(home, ".pi", "agent", "skills", "hidden", "SKILL.md");
    writeFileSync(stale, "mine");
    rmSync(join(project, "skills", "hidden"), { recursive: true });

    expect(() => installProject(discoverProject({ project }), { harness: "pi", root: home, stateHome: state, force: true })).toThrow("was modified");
    expect(readFileSync(stale, "utf8")).toBe("mine");
  });

  test.skipIf(process.platform === "win32")("rejects desired files that alias the same physical target", () => {
    const { project, home, state } = fixture();
    mkdirSync(join(home, "real"));
    symlinkSync(join(home, "real"), join(home, "alias"));

    expect(() => installProject(discoverProject({ project }), {
      harness: "pi",
      root: home,
      stateHome: state,
      paths: { skills: "real", commands: "commands", rules: "alias/example/SKILL.md" },
    })).toThrow("overlapping physical installation destinations");
    expect(existsSync(join(home, "real", "example", "SKILL.md"))).toBe(false);
  });


  test("never follows a destination symlink outside root, even with force", () => {
    const { root, project, home, state } = fixture();
    const outside = join(root, "outside");
    mkdirSync(outside);
    mkdirSync(join(home, ".pi"));
    symlinkSync(outside, join(home, ".pi", "agent"));
    expect(() => installProject(discoverProject({ project }), { harness: "pi", root: home, stateHome: state, force: true })).toThrow("symlink outside --root");
    expect(existsSync(join(outside, "skills"))).toBe(false);
  });

  test("installs one harness into custom paths and migrates a later layout change", () => {
    const { project, home, state } = fixture();
    const resolved = discoverProject({ project });
    const custom = {
      skills: ".config/opencode-v2/skills",
      commands: ".config/opencode-v2/commands",
    };
    const dry = installProject(resolved, { harness: "opencode", root: home, stateHome: state, paths: custom, dryRun: true });
    expect(dry.changes).toContainEqual({ path: ".config/opencode-v2/skills/example/SKILL.md", action: "add" });
    expect(dry.changes).toContainEqual({ path: ".config/opencode-v2/commands/example.md", action: "add" });
    expect(existsSync(join(home, ".config"))).toBe(false);

    const first = installProject(resolved, { harness: "opencode", root: home, stateHome: state, paths: custom });
    expect(existsSync(join(home, ".config", "opencode-v2", "skills", "example", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".config", "opencode-v2", "commands", "example.md"))).toBe(true);
    expect(existsSync(join(home, ".config", "opencode", "AGENTS.md"))).toBe(true);
    expect(existsSync(join(home, ".config", "opencode", "skills", "example", "SKILL.md"))).toBe(false);
    expect(first.changes).toEqual(dry.changes);

    const moved = {
      skills: ".config/opencode-alt/skills",
      commands: ".config/opencode-v2/commands",
    };
    const planned = installProject(resolved, { harness: "opencode", root: home, stateHome: state, paths: moved, dryRun: true });
    expect(planned.changes).toContainEqual({ path: ".config/opencode-v2/skills/example/SKILL.md", action: "delete" });
    expect(planned.changes).toContainEqual({ path: ".config/opencode-alt/skills/example/SKILL.md", action: "add" });
    expect(existsSync(join(home, ".config", "opencode-v2", "skills", "example", "SKILL.md"))).toBe(true);

    installProject(resolved, { harness: "opencode", root: home, stateHome: state, paths: moved });
    expect(existsSync(join(home, ".config", "opencode-v2", "skills", "example", "SKILL.md"))).toBe(false);
    expect(existsSync(join(home, ".config", "opencode-alt", "skills", "example", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".config", "opencode-v2", "commands", "example.md"))).toBe(true);

    const stale = join(home, ".config", "opencode-alt", "skills", "example", "SKILL.md");
    writeFileSync(stale, "edited");
    expect(() => installProject(resolved, { harness: "opencode", root: home, stateHome: state, paths: custom })).toThrow("was modified");
    expect(readFileSync(stale, "utf8")).toBe("edited");
  });

  test("adopts a retired opencode-v2 receipt only when destinations overlap", () => {
    const { project, home, state } = fixture();
    const resolved = discoverProject({ project });
    const retiredPaths = {
      skills: ".config/opencode-v2/skills",
      commands: ".config/opencode-v2/commands",
      rules: ".config/opencode-v2/AGENTS.md",
    };
    const retired = installProject(resolved, { harness: "opencode", root: home, stateHome: state, paths: retiredPaths });
    const receipt = JSON.parse(readFileSync(retired.statePath, "utf8")) as Record<string, unknown>;
    receipt.harness = "opencode-v2";
    const retiredStatePath = join(dirname(dirname(retired.statePath)), "opencode-v2", basename(retired.statePath));
    mkdirSync(dirname(retiredStatePath), { recursive: true });
    writeFileSync(retiredStatePath, `${JSON.stringify(receipt)}\n`);
    rmSync(retired.statePath);

    const defaultInstall = installProject(resolved, { harness: "opencode", root: home, stateHome: state });
    expect(existsSync(retiredStatePath)).toBe(true);
    expect(existsSync(join(home, retiredPaths.skills, "example", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".config/opencode/skills/example/SKILL.md"))).toBe(true);
    expect(existsSync(defaultInstall.statePath)).toBe(true);

    const paths = { skills: retiredPaths.skills, commands: retiredPaths.commands };
    const planned = installProject(resolved, { harness: "opencode", root: home, stateHome: state, paths, dryRun: true });
    expect(planned.changes).toContainEqual({ path: retiredPaths.rules, action: "delete" });
    expect(existsSync(retiredStatePath)).toBe(true);
    expect(existsSync(planned.statePath)).toBe(true);

    installProject(resolved, { harness: "opencode", root: home, stateHome: state, paths });
    expect(existsSync(retiredStatePath)).toBe(false);
    expect(existsSync(planned.statePath)).toBe(true);
    expect(existsSync(join(home, retiredPaths.rules))).toBe(false);
    expect(existsSync(join(home, ".config/opencode/AGENTS.md"))).toBe(true);
  });

  test("refuses unsafe, overlapping, and foreign-owned custom paths even with force", () => {
    const { project, home, state } = fixture();
    const resolved = discoverProject({ project });
    expect(() => installProject(resolved, {
      harness: "opencode",
      root: home,
      stateHome: state,
      paths: { skills: "../escape/skills" },
    })).toThrow("unsafe installation path");
    expect(() => installProject(resolved, {
      harness: "opencode",
      root: home,
      stateHome: state,
      paths: { skills: ".config/shared/", commands: ".config/shared/commands" },
    })).toThrow("overlapping");
    expect(existsSync(join(home, ".config"))).toBe(false);

    installProject(resolved, { harness: "opencode", root: home, stateHome: state });
    const nestedRoot = join(home, ".config");
    symlinkSync(join(nestedRoot, "opencode"), join(nestedRoot, "opencode-alias"));
    expect(() => installProject(resolved, {
      harness: "pi",
      root: nestedRoot,
      stateHome: state,
      paths: { skills: "opencode-alias/skills", commands: "pi/prompts", rules: "pi/AGENTS.md" },
      force: true,
    })).toThrow("another installation");
    expect(existsSync(join(nestedRoot, "pi"))).toBe(false);
  });
});
