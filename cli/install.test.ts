import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

  test("never follows a destination symlink outside root, even with force", () => {
    const { root, project, home, state } = fixture();
    const outside = join(root, "outside");
    mkdirSync(outside);
    mkdirSync(join(home, ".pi"));
    symlinkSync(outside, join(home, ".pi", "agent"));
    expect(() => installProject(discoverProject({ project }), { harness: "pi", root: home, stateHome: state, force: true })).toThrow("symlink outside --root");
    expect(existsSync(join(outside, "skills"))).toBe(false);
  });
});
